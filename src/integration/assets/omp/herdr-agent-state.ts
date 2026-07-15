// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this file.
// add custom hooks/plugins beside this file instead of editing it.
// HERDR_INTEGRATION_ID=omp
// HERDR_INTEGRATION_VERSION=6
// @ts-nocheck

import { createConnection } from "node:net";

const HERDR_ENV = process.env.HERDR_ENV;
const socketPath = process.env.HERDR_SOCKET_PATH;
const paneId = process.env.HERDR_PANE_ID;
const source = "herdr:omp";

function enabled() {
  return HERDR_ENV === "1" && !!socketPath && !!paneId;
}

let requestQueue = Promise.resolve();

function sendRequestAttempt(request: unknown, timeoutMs: number): Promise<boolean> {
  if (!enabled()) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (delivered: boolean) => {
      if (done) return;
      done = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      socket.destroy();
      resolve(delivered);
    };

    const socket = createConnection(socketPath!);
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", () => finish(true));
    socket.on("end", () => finish(false));
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
  });
}

async function sendRequestNow(request: unknown): Promise<void> {
  if (await sendRequestAttempt(request, 500)) {
    return;
  }
  await sendRequestAttempt(request, 1500);
}

function sendRequest(request: unknown): Promise<void> {
  requestQueue = requestQueue.then(
    () => sendRequestNow(request),
    () => sendRequestNow(request),
  );
  return requestQueue;
}

type AgentState = "working" | "blocked" | "idle";

type QueuedState = {
  state: AgentState;
  message?: string;
};

const idleDebounceMs = parseDurationEnv("HERDR_OMP_IDLE_DEBOUNCE_MS", 250);
const retryGraceMs = parseDurationEnv("HERDR_OMP_RETRY_GRACE_MS", 2500);
const retryableErrorPattern =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;
let reportSeq = Date.now() * 1000;
let currentAgentSessionId: string | undefined;
let currentAgentSessionPath: string | undefined;

function nextReportSeq(): number {
  reportSeq += 1;
  return reportSeq;
}

function updateSessionRef(ctx: any): void {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    currentAgentSessionPath =
      typeof file === "string" && file.startsWith("/") ? file : undefined;
  } catch {
    currentAgentSessionPath = undefined;
  }

  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    currentAgentSessionId = typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    currentAgentSessionId = undefined;
  }
}

function withSessionRef(params: Record<string, unknown>): Record<string, unknown> {
  if (currentAgentSessionPath) {
    return { ...params, agent_session_path: currentAgentSessionPath };
  }
  if (currentAgentSessionId) {
    return { ...params, agent_session_id: currentAgentSessionId };
  }
  return params;
}

function parseDurationEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function currentSessionRef(): Record<string, unknown> | undefined {
  if (currentAgentSessionPath) {
    return { agent_session_path: currentAgentSessionPath };
  }
  if (currentAgentSessionId) {
    return { agent_session_id: currentAgentSessionId };
  }
  return undefined;
}

function reportSession(sessionStartSource = "startup"): Promise<void> {
  const sessionRef = currentSessionRef();
  if (!sessionRef) {
    return Promise.resolve();
  }

  return sendRequest({
    id: `${source}:session:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_agent_session",
    params: {
      pane_id: paneId,
      source,
      agent: "omp",
      seq: nextReportSeq(),
      session_start_source: sessionStartSource,
      ...sessionRef,
    },
  });
}

function sendState(state: AgentState, message?: string, seq = nextReportSeq()): Promise<void> {
  return sendRequest({
    id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_agent",
    params: withSessionRef({
      pane_id: paneId,
      source,
      agent: "omp",
      state,
      message,
      seq,
    }),
  });
}

function releaseAgent(): Promise<void> {
  return sendRequest({
    id: `${source}:release:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.release_agent",
    params: {
      pane_id: paneId,
      source,
      agent: "omp",
      seq: nextReportSeq(),
    },
  });
}

function shouldReleaseOnSessionShutdown(event: any): boolean {
  // OMP tears down and rebinds extension runtimes for internal lifecycle actions
  // such as /reload, /new, /resume, and /fork. Those do not mean the pane's
  // agent process has exited, and releasing hook authority there can suppress
  // legitimate reports from the replacement runtime. Only a user/process quit
  // should release Herdr's full-lifecycle authority.
  const reason = event?.reason;
  return reason === "quit";
}

let sendInFlight = false;
let queuedState: QueuedState | undefined;

function queueState(state: AgentState, message?: string): void {
  queuedState = { state, message };
  if (!sendInFlight) {
    void drainStateQueue();
  }
}

async function drainStateQueue(): Promise<void> {
  if (sendInFlight) {
    return;
  }

  sendInFlight = true;
  try {
    while (queuedState) {
      const next = queuedState;
      queuedState = undefined;
      await sendState(next.state, next.message);
    }
  } finally {
    sendInFlight = false;
    if (queuedState) {
      void drainStateQueue();
    }
  }
}

function lastAssistantMessage(messages: unknown[]): any | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as any;
    if (message?.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

function retryableErrorMessage(event: any): string | undefined {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const assistant = lastAssistantMessage(messages);
  if (assistant?.stopReason !== "error") {
    return undefined;
  }

  const errorMessage = String(assistant.errorMessage ?? "");
  if (!retryableErrorPattern.test(errorMessage)) {
    return undefined;
  }
  return errorMessage || "retryable provider error";
}

function askBlockedMessage(args: any): string {
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  const firstQuestion = questions.find((question: any) => typeof question?.question === "string");
  if (firstQuestion?.question) {
    return firstQuestion.question;
  }
  return "waiting for user input";
}

const metadataTokenNames = [
  "omp_context_used",
  "omp_context_window",
  "omp_context_percent",
  "omp_active_subagents",
];

function decimalString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.length > 0 && Number.isFinite(Number(value))) {
    return value;
  }
  return undefined;
}

function contextUsageTokens(ctx: unknown): Record<string, string> | undefined {
  try {
    const usage = ctx?.getContextUsage?.();
    if (!usage || typeof usage !== "object") {
      return undefined;
    }
    const tokens = decimalString(usage.tokens);
    const contextWindow = decimalString(usage.contextWindow);
    const percent = decimalString(usage.percent);
    if (!tokens || !contextWindow || !percent) {
      return undefined;
    }
    return {
      omp_context_used: tokens,
      omp_context_window: contextWindow,
      omp_context_percent: percent,
    };
  } catch {
    return undefined;
  }
}

function reportMetadata(
  title: string | undefined,
  tokens: Record<string, string | null>,
): Promise<void> {
  return sendRequest({
    id: `${source}:metadata:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_metadata",
    params: {
      pane_id: paneId,
      source,
      agent: "omp",
      seq: nextReportSeq(),
      ...(title ? { title } : { clear_title: true }),
      tokens,
    },
  });
}

function lifecycleSubagentId(event: unknown): string | undefined {
  const candidate = event?.id ?? event?.taskId ?? event?.task_id ?? event?.subagentId ?? event?.subagent_id;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function lifecycleStatus(event: unknown): string | undefined {
  const candidate = event?.status ?? event?.state ?? event?.phase;
  return typeof candidate === "string" ? candidate.toLowerCase() : undefined;
}

type RootSubagentCollector = (channel: string, event: unknown) => void;

type SubagentCollectorBridge = {
  collectors: Map<string, RootSubagentCollector>;
  owners: Map<string, string>;
};

const collectorBridgeSymbol = Symbol.for("herdr.omp.subagent-collector-bridge");

function subagentCollectorBridge(): SubagentCollectorBridge {
  const root = globalThis as typeof globalThis & {
    [collectorBridgeSymbol]?: SubagentCollectorBridge;
  };
  if (!root[collectorBridgeSymbol]) {
    root[collectorBridgeSymbol] = {
      collectors: new Map(),
      owners: new Map(),
    };
  }
  return root[collectorBridgeSymbol];
}

function sessionRefKey(sessionRef: Record<string, unknown> | undefined): string | undefined {
  if (!sessionRef) {
    return undefined;
  }
  const path = sessionRef.agent_session_path;
  if (typeof path === "string") {
    return `path:${path}`;
  }
  const id = sessionRef.agent_session_id;
  return typeof id === "string" ? `id:${id}` : undefined;
}

function sessionRefFromContext(ctx: unknown): Record<string, unknown> | undefined {
  try {
    const path = ctx?.sessionManager?.getSessionFile?.();
    if (typeof path === "string" && path.startsWith("/")) {
      return { agent_session_path: path };
    }
  } catch {
    // Session IDs remain available in --no-session mode.
  }
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id.length > 0) {
      return { agent_session_id: id };
    }
  } catch {
    // No session identity is available yet.
  }
  return undefined;
}

function subagentSessionKeys(event: unknown, id: string): string[] {
  const keys = new Set([`id:${id}`]);
  for (const candidate of [
    event?.sessionFile,
    event?.session_file,
    event?.agentSessionFile,
    event?.agent_session_path,
    event?.sessionId,
    event?.session_id,
    event?.agentSessionId,
    event?.agent_session_id,
  ]) {
    if (typeof candidate === "string" && candidate.length > 0) {
      keys.add(candidate.startsWith("/") ? `path:${candidate}` : `id:${candidate}`);
    }
  }
  return [...keys];
}


export default function (pi) {
  if (!enabled()) {
    return;
  }

  let agentActive = false;
  let retryHoldActive = false;
  let failureBlocked = false;
  let failureMessage: string | undefined;
  let blockedCount = 0;
  let blockedMessage: string | undefined;
  let lastState: AgentState | undefined;
  let lastMessage: string | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let currentContext: unknown;
  let localSessionKey: string | undefined;
  let registeredSessionKey: string | undefined;
  let reportedSessionRef: string | undefined;
  let lastMetadataSignature: string | undefined;
  const activeSubagents = new Set<string>();
  const terminalSubagents = new Set<string>();
  const retiredSubagents = new Set<string>();
  const lifecycleManagedSubagents = new Set<string>();
  const knownSubagents = new Set<string>();

  function clearTimer(timer: ReturnType<typeof setTimeout> | undefined) {
    if (timer) {
      clearTimeout(timer);
    }
  }

  function clearPendingTimers() {
    clearTimer(idleTimer);
    clearTimer(retryTimer);
    idleTimer = undefined;
    retryTimer = undefined;
  }

  function clearFailureState() {
    retryHoldActive = false;
    failureBlocked = false;
    failureMessage = undefined;
  }

  function desiredState() {
    if (blockedCount > 0) {
      return { state: "blocked" as const, message: blockedMessage };
    }
    if (failureBlocked) {
      return { state: "blocked" as const, message: failureMessage };
    }
    if (agentActive || retryHoldActive) {
      return { state: "working" as const, message: undefined };
    }
    return { state: "idle" as const, message: undefined };
  }

  function publishState(force = false) {
    const next = desiredState();
    if (!force && next.state === lastState && next.message === lastMessage) {
      return;
    }
    lastState = next.state;
    lastMessage = next.message;
    queueState(next.state, next.message);
  }

  function reportMetadataIfChanged(title: string | undefined, tokens: Record<string, string | null>) {
    const signature = JSON.stringify([title ?? null, metadataTokenNames.map((name) => tokens[name])]);
    if (signature === lastMetadataSignature) {
      return;
    }
    lastMetadataSignature = signature;
    void reportMetadata(title, tokens);
  }

  function reportCurrentMetadata(ctx: unknown, clear = false) {
    if (clear) {
      reportMetadataIfChanged(
        undefined,
        Object.fromEntries(metadataTokenNames.map((name) => [name, null])),
      );
      return;
    }
    const manager = ctx?.sessionManager;
    let title: string | undefined;
    try {
      const candidate = manager?.getSessionName?.();
      title = typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
    } catch {
      title = undefined;
    }
    const usage = contextUsageTokens(ctx);
    const tokens: Record<string, string | null> = {};
    for (const name of metadataTokenNames) {
      tokens[name] =
        usage?.[name] ??
        (name === "omp_active_subagents" ? String(activeSubagents.size) : null);
    }
    reportMetadataIfChanged(title, tokens);
  }

  function resetSessionState() {
    clearPendingTimers();
    clearFailureState();
    agentActive = false;
    blockedCount = 0;
    blockedMessage = undefined;
    for (const id of knownSubagents) {
      retiredSubagents.add(id);
    }
    activeSubagents.clear();
    terminalSubagents.clear();
    lifecycleManagedSubagents.clear();
    knownSubagents.clear();
  }

  function unregisterRootCollector() {
    if (!registeredSessionKey) {
      return;
    }
    const bridge = subagentCollectorBridge();
    bridge.collectors.delete(registeredSessionKey);
    for (const [childSessionKey, rootSessionKey] of bridge.owners) {
      if (rootSessionKey === registeredSessionKey) {
        bridge.owners.delete(childSessionKey);
      }
    }
    registeredSessionKey = undefined;
  }

  function registerRootCollector() {
    const sessionKey = sessionRefKey(currentSessionRef());
    if (!sessionKey || registeredSessionKey === sessionKey) {
      return;
    }
    unregisterRootCollector();
    registeredSessionKey = sessionKey;
    subagentCollectorBridge().collectors.set(sessionKey, (channel, event) => {
      collectSubagentEvent(channel, event);
    });
  }

  function ensureInteractiveSession(ctx: unknown, sessionStartSource = "startup"): boolean {
    if (ctx?.hasUI !== true) {
      return false;
    }
    const previousSession = currentSessionRef();
    updateSessionRef(ctx);
    const nextSession = currentSessionRef();
    localSessionKey = sessionRefKey(nextSession);
    const previousSessionKey = previousSession ? JSON.stringify(previousSession) : undefined;
    const nextSessionKey = nextSession ? JSON.stringify(nextSession) : undefined;
    if (previousSessionKey && nextSessionKey && previousSessionKey !== nextSessionKey) {
      unregisterRootCollector();
      resetSessionState();
      reportCurrentMetadata(currentContext, true);
    }
    currentContext = ctx;
    registerRootCollector();
    if (nextSessionKey && nextSessionKey !== reportedSessionRef) {
      reportedSessionRef = nextSessionKey;
      void reportSession(sessionStartSource);
    }
    reportCurrentMetadata(ctx);
    return true;
  }

  function scheduleIdle() {
    clearPendingTimers();
    clearFailureState();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      publishState();
    }, idleDebounceMs);
    idleTimer.unref?.();
  }

  function holdForRetry(message: string) {
    clearPendingTimers();
    retryHoldActive = true;
    failureBlocked = false;
    failureMessage = message;
    publishState();
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      retryHoldActive = false;
      failureBlocked = true;
      publishState();
    }, retryGraceMs);
    retryTimer.unref?.();
  }

  function activateBlocked(message: string | undefined) {
    clearPendingTimers();
    blockedCount += 1;
    blockedMessage = message;
    publishState();
  }

  function deactivateBlocked() {
    blockedCount = Math.max(0, blockedCount - 1);
    if (blockedCount === 0) {
      blockedMessage = undefined;
    }
    publishState();
  }

  pi.events.on("herdr:blocked", (data, ctx) => {
    if (!ensureInteractiveSession(ctx ?? currentContext)) {
      return;
    }
    if (!data?.active) {
      deactivateBlocked();
      return;
    }
    activateBlocked(data.label);
  });

  // OMP lifecycle is present only in newer releases. Older event/progress
  // channels let us derive the same activity from their payloads.
  function updateSubagentActivity(id: string, active: boolean, terminal = false) {
    if (terminal) {
      terminalSubagents.add(id);
    }
    if (active && terminalSubagents.has(id)) {
      return;
    }
    const wasActive = activeSubagents.has(id);
    if (active) {
      activeSubagents.add(id);
    } else {
      activeSubagents.delete(id);
    }
    if (wasActive !== activeSubagents.has(id)) {
      reportCurrentMetadata(currentContext);
    }
  }

  function collectSubagentEvent(channel: string, event: unknown) {
    const progress = event?.progress;
    const progressId = progress?.id;
    const id =
      channel === "task:subagent:progress"
        ? typeof progressId === "string" || typeof progressId === "number"
          ? String(progressId)
          : undefined
        : lifecycleSubagentId(event) ??
          (typeof event?.index === "number" || typeof event?.index === "string"
            ? `index:${event.index}`
            : undefined);
    if (!id) {
      return;
    }

    if (channel === "task:subagent:lifecycle") {
      const status = lifecycleStatus(event);
      if (status === "started") {
        // A follow-up turn deliberately reuses the persistent subagent ID.
        // Only the explicit lifecycle transition may open that new epoch.
        retiredSubagents.delete(id);
        terminalSubagents.delete(id);
        lifecycleManagedSubagents.add(id);
        knownSubagents.add(id);
        if (registeredSessionKey) {
          const owners = subagentCollectorBridge().owners;
          for (const childSessionKey of subagentSessionKeys(event, id)) {
            owners.set(childSessionKey, registeredSessionKey);
          }
        }
        updateSubagentActivity(id, true);
      } else if (status === "completed" || status === "failed" || status === "aborted") {
        if (retiredSubagents.delete(id)) {
          return;
        }
        lifecycleManagedSubagents.add(id);
        knownSubagents.add(id);
        updateSubagentActivity(id, false, true);
      }
      return;
    }

    const status =
      channel === "task:subagent:progress" ? lifecycleStatus(progress) : undefined;
    const terminal = status === "completed" || status === "failed" || status === "aborted";
    if (retiredSubagents.has(id)) {
      if (terminal) {
        retiredSubagents.delete(id);
      }
      return;
    }
    // Once lifecycle has established an epoch, unscoped fallback events might
    // belong to its previous turn and must not change the current activity.
    if (lifecycleManagedSubagents.has(id)) {
      return;
    }
    knownSubagents.add(id);

    if (channel === "task:subagent:progress") {
      updateSubagentActivity(id, !terminal, terminal);
      return;
    }

    const type = event?.event?.type ?? event?.event?.name ?? event?.event?.event;
    if (type === "agent_start") {
      updateSubagentActivity(id, true);
    } else if (type === "agent_end") {
      // agent_end concludes one AgentSessionEvent turn — deactivate without
      // marking terminal, since a future lifecycle transition may reuse the id.
      updateSubagentActivity(id, false);
    }
  }

  function routeSubagentEvent(channel: string, event: unknown) {
    if (registeredSessionKey) {
      collectSubagentEvent(channel, event);
      return;
    }
    const ownerSessionKey = localSessionKey
      ? subagentCollectorBridge().owners.get(localSessionKey)
      : undefined;
    if (ownerSessionKey) {
      subagentCollectorBridge().collectors.get(ownerSessionKey)?.(channel, event);
    }
  }

  pi.events.on("task:subagent:lifecycle", (event) => {
    routeSubagentEvent("task:subagent:lifecycle", event);
  });
  pi.events.on("task:subagent:progress", (event) => {
    routeSubagentEvent("task:subagent:progress", event);
  });
  pi.events.on("task:subagent:event", (event) => {
    routeSubagentEvent("task:subagent:event", event);
  });

  pi.on("session_start", (event, ctx) => {
    localSessionKey = sessionRefKey(sessionRefFromContext(ctx)) ?? localSessionKey;
    if (!ensureInteractiveSession(ctx, event?.reason || "startup")) {
      return;
    }
    agentActive = ctx?.isIdle?.() === false;
    publishState(true);
  });

  pi.on("session_switch", (event, ctx) => {
    localSessionKey = sessionRefKey(sessionRefFromContext(ctx)) ?? localSessionKey;
    if (!ensureInteractiveSession(ctx, event?.reason || "resume")) {
      return;
    }
    resetSessionState();
    reportCurrentMetadata(ctx);
    publishState(true);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!ensureInteractiveSession(ctx)) {
      return;
    }
    clearPendingTimers();
    clearFailureState();
    agentActive = true;
    publishState();
  });

  pi.on("turn_start", (_event, ctx) => {
    if (!ensureInteractiveSession(ctx)) {
      return;
    }
    clearPendingTimers();
    clearFailureState();
    agentActive = true;
    publishState();
  });

  pi.on("tool_approval_requested", (event, ctx) => {
    if (!ensureInteractiveSession(ctx)) {
      return;
    }
    activateBlocked(event?.reason || `${event?.toolName || "Tool"} approval`);
  });

  pi.on("tool_approval_resolved", (_event, ctx) => {
    if (!ensureInteractiveSession(ctx)) {
      return;
    }
    deactivateBlocked();
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (event?.toolName === "ask" && ensureInteractiveSession(ctx)) {
      activateBlocked(askBlockedMessage(event.args));
    }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (event?.toolName === "ask" && ensureInteractiveSession(ctx)) {
      deactivateBlocked();
    }
  });

  pi.on("auto_retry_start", (_event, ctx) => {
    if (!ensureInteractiveSession(ctx)) {
      return;
    }
    clearPendingTimers();
    retryHoldActive = true;
    failureBlocked = false;
    publishState();
  });

  pi.on("auto_retry_end", (_event, ctx) => {
    if (!ensureInteractiveSession(ctx)) {
      return;
    }
    retryHoldActive = false;
    publishState();
  });

  pi.on("agent_end", (event, ctx) => {
    if (!ensureInteractiveSession(ctx ?? currentContext) || !agentActive) {
      return;
    }
    agentActive = false;
    const retryableMessage = retryableErrorMessage(event);
    if (retryableMessage) {
      holdForRetry(retryableMessage);
      return;
    }
    scheduleIdle();
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (!ensureInteractiveSession(ctx ?? currentContext)) {
      return;
    }
    clearPendingTimers();
    if (shouldReleaseOnSessionShutdown(event)) {
      unregisterRootCollector();
      resetSessionState();
      reportCurrentMetadata(currentContext, true);
      await releaseAgent();
    }
  });
}
