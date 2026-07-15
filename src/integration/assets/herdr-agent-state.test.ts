import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalEnvironment = {
  HERDR_ENV: process.env.HERDR_ENV,
  HERDR_OMP_IDLE_DEBOUNCE_MS: process.env.HERDR_OMP_IDLE_DEBOUNCE_MS,
  HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
};

let server: Server | undefined;
let socketPath: string | undefined;
let importCounter = 0;

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server = undefined;

  if (socketPath) {
    await rm(socketPath, { force: true });
    socketPath = undefined;
  }

  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

const integrations = [
  { name: "Pi", modulePath: "./pi/herdr-agent-state.ts" },
  { name: "Oh My Pi", modulePath: "./omp/herdr-agent-state.ts" },
] as const;

function importFresh(modulePath: string) {
  importCounter += 1;
  return import(`${modulePath}?test=${importCounter}`);
}

type Handler = (event: unknown, context: unknown) => unknown;

function createExtensionHarness() {
  const handlers = new Map<string, Handler>();
  const eventHandlers = new Map<string, Handler>();
  return {
    handlers,
    eventHandlers,
    pi: {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      events: {
        on(event: string, handler: Handler) {
          eventHandlers.set(event, handler);
          return () => eventHandlers.delete(event);
        },
      },
    },
  };
}

function configureIntegrationEnvironment(recordingSocketPath: string) {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = recordingSocketPath;
  process.env.HERDR_PANE_ID = "test:p1";
}

async function startRecordingServer(name: string): Promise<unknown[]> {
  const recordingSocketPath = join(tmpdir(), `herdr-${name}-${process.pid}.sock`);
  socketPath = recordingSocketPath;
  await rm(recordingSocketPath, { force: true });

  const requests: unknown[] = [];
  const recordingServer = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) {
        return;
      }
      requests.push(JSON.parse(input.slice(0, newline)));
      socket.end("{}\n");
    });
  });
  server = recordingServer;
  await new Promise<void>((resolve, reject) => {
    recordingServer.once("error", reject);
    recordingServer.listen(recordingSocketPath, resolve);
  });
  configureIntegrationEnvironment(recordingSocketPath);
  return requests;
}

for (const integration of integrations) {
  test(`${integration.name} reload preserves working state when the agent is active`, async () => {
    const requests = await startRecordingServer(
      integration.name.toLowerCase().replaceAll(" ", "-"),
    );
    const { handlers, pi } = createExtensionHarness();

    const { default: install } = await importFresh(integration.modulePath);
    install(pi);

    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeDefined();
    await sessionStart?.(
      { reason: "reload" },
      {
        hasUI: true,
        isIdle: () => false,
        sessionManager: {
          getSessionFile: () => undefined,
          getSessionId: () => undefined,
        },
      },
    );

    const reportedState = () => {
      for (const request of requests) {
        if (!isRecord(request) || request.method !== "pane.report_agent") {
          continue;
        }
        const params = request.params;
        if (isRecord(params) && typeof params.state === "string") {
          return params.state;
        }
      }
      return undefined;
    };

    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && reportedState() === undefined) {
      await Bun.sleep(5);
    }

    expect(reportedState()).toBe("working");
  });
}

test("Pi reports the session replacement source", async () => {
  const requests = await startRecordingServer("pi-session-source");
  const { handlers, pi } = createExtensionHarness();

  const { default: install } = await importFresh("./pi/herdr-agent-state.ts");
  install(pi);

  const sessionStart = handlers.get("session_start");
  expect(sessionStart).toBeDefined();
  await sessionStart?.(
    { reason: "new" },
    {
      hasUI: true,
      isIdle: () => true,
      sessionManager: {
        getSessionFile: () => "/tmp/pi-new.jsonl",
        getSessionId: () => "pi-new",
      },
    },
  );

  const reportedSession = () =>
    requests.find((request) => isRecord(request) && request.method === "pane.report_agent_session");
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline && reportedSession() === undefined) {
    await Bun.sleep(5);
  }

  const request = reportedSession();
  expect(request).toBeDefined();
  expect(isRecord(request) && isRecord(request.params) ? request.params.session_start_source : null)
    .toBe("new");
});

test("Pi waits for a replacement session report before publishing state", async () => {
  const recordingSocketPath = join(tmpdir(), `herdr-pi-session-order-${process.pid}.sock`);
  socketPath = recordingSocketPath;
  await rm(recordingSocketPath, { force: true });

  const requests: unknown[] = [];
  let acknowledgeSessionReport: (() => void) | undefined;
  const recordingServer = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const request = JSON.parse(input.slice(0, newline));
      requests.push(request);
      if (isRecord(request) && request.method === "pane.report_agent_session") {
        acknowledgeSessionReport = () => socket.end("{}\n");
        return;
      }
      socket.end("{}\n");
    });
  });
  server = recordingServer;
  await new Promise<void>((resolve, reject) => {
    recordingServer.once("error", reject);
    recordingServer.listen(recordingSocketPath, resolve);
  });

  configureIntegrationEnvironment(recordingSocketPath);
  const { handlers, pi } = createExtensionHarness();
  const { default: install } = await importFresh("./pi/herdr-agent-state.ts");
  install(pi);

  const sessionStart = handlers.get("session_start");
  expect(sessionStart).toBeDefined();
  const sessionStartResult = sessionStart?.(
    { reason: "new" },
    {
      hasUI: true,
      isIdle: () => false,
      sessionManager: {
        getSessionFile: () => "/tmp/pi-new.jsonl",
        getSessionId: () => "pi-new",
      },
    },
  );

  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline && acknowledgeSessionReport === undefined) {
    await Bun.sleep(5);
  }
  expect(acknowledgeSessionReport).toBeDefined();
  expect(
    requests.some((request) => isRecord(request) && request.method === "pane.report_agent"),
  ).toBe(false);

  acknowledgeSessionReport?.();
  await sessionStartResult;

  const stateDeadline = Date.now() + 1_000;
  while (
    Date.now() < stateDeadline &&
    !requests.some((request) => isRecord(request) && request.method === "pane.report_agent")
  ) {
    await Bun.sleep(5);
  }
  expect(requests.map((request) => (isRecord(request) ? request.method : undefined))).toEqual([
    "pane.report_agent_session",
    "pane.report_agent",
  ]);
});

async function startDroppedFirstResponseServer(
  name: string,
  shouldDropFirstResponse?: (request: unknown) => boolean,
) {
  const recordingSocketPath = join(tmpdir(), `herdr-${name}-${process.pid}.sock`);
  socketPath = recordingSocketPath;
  await rm(recordingSocketPath, { force: true });

  let connectionCount = 0;
  let droppedFirstResponse = false;
  const attemptedRequests: unknown[] = [];
  const deliveredRequests: unknown[] = [];
  const recordingServer = createServer((socket) => {
    connectionCount += 1;
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const request = JSON.parse(input.slice(0, newline));
      attemptedRequests.push(request);
      if (
        !droppedFirstResponse &&
        (shouldDropFirstResponse?.(request) ?? true)
      ) {
        droppedFirstResponse = true;
        return;
      }
      deliveredRequests.push(request);
      socket.end("{}\n");
    });
  });
  server = recordingServer;
  await new Promise<void>((resolve, reject) => {
    recordingServer.once("error", reject);
    recordingServer.listen(recordingSocketPath, resolve);
  });

  configureIntegrationEnvironment(recordingSocketPath);
  return {
    attemptedRequests,
    deliveredRequests,
    connectionCount: () => connectionCount,
  };
}

test("Oh My Pi retries working before a queued idle state", async () => {
  const { attemptedRequests } = await startDroppedFirstResponseServer(
    "omp-retry",
    (request) => isRecord(request) && request.method === "pane.report_agent",
  );
  process.env.HERDR_OMP_IDLE_DEBOUNCE_MS = "0";
  const { handlers, pi } = createExtensionHarness();

  const { default: install } = await importFresh("./omp/herdr-agent-state.ts");
  install(pi);

  const context = {
    hasUI: true,
    isIdle: () => false,
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
    },
  };
  handlers.get("session_start")?.({ reason: "startup" }, context);
  handlers.get("agent_end")?.({ messages: [] }, context);

  const deadline = Date.now() + 2_500;
  while (
    Date.now() < deadline &&
    attemptedRequests.filter(
      (request) => isRecord(request) && request.method === "pane.report_agent",
    ).length < 3
  ) {
    await Bun.sleep(5);
  }

  const stateRequests = attemptedRequests.filter(
    (request) => isRecord(request) && request.method === "pane.report_agent",
  );
  expect(stateRequests).toHaveLength(3);
  expect(stateRequests[1]).toEqual(stateRequests[0]);
  expect(requestState(stateRequests[0])).toBe("working");
  expect(requestState(stateRequests[2])).toBe("idle");
});

test("Pi retries working state after an unanswered socket attempt", async () => {
  const { attemptedRequests, deliveredRequests, connectionCount } =
    await startDroppedFirstResponseServer("pi-retry");
  const { handlers, pi } = createExtensionHarness();

  const { default: install } = await importFresh("./pi/herdr-agent-state.ts");
  install(pi);

  const sessionStart = handlers.get("session_start");
  expect(sessionStart).toBeDefined();
  await sessionStart?.(
    { reason: "startup" },
    {
      hasUI: true,
      isIdle: () => false,
      sessionManager: {
        getSessionFile: () => undefined,
        getSessionId: () => undefined,
      },
    },
  );

  const reportedWorking = () =>
    deliveredRequests.some((request) => {
      if (!isRecord(request) || request.method !== "pane.report_agent") {
        return false;
      }
      const params = request.params;
      return isRecord(params) && params.state === "working";
    });

  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline && !reportedWorking()) {
    await Bun.sleep(5);
  }

  expect(connectionCount()).toBeGreaterThanOrEqual(2);
  expect(attemptedRequests.length).toBeGreaterThanOrEqual(2);
  expect(attemptedRequests[1]).toEqual(attemptedRequests[0]);
  expect(reportedWorking()).toBe(true);
});

test("Oh My Pi activates from agent_start, reports metadata, and tracks subagents", async () => {
  const requests = await startRecordingServer("omp-telemetry");
  const { handlers, eventHandlers, pi } = createExtensionHarness();
  const { default: install } = await importFresh("./omp/herdr-agent-state.ts");
  install(pi);

  const context = {
    hasUI: true,
    isIdle: () => false,
    getContextUsage: () => ({ tokens: 12.5, contextWindow: 100, percent: 12.5 }),
    sessionManager: {
      getSessionFile: () => "/tmp/omp-session.jsonl",
      getSessionId: () => "omp-session",
      getSessionName: () => "Named OMP session",
    },
  };
  await handlers.get("agent_start")?.({}, context);
  eventHandlers.get("task:subagent:lifecycle")?.(
    { id: "child-1", status: "started", sessionFile: "/tmp/omp-child-1.jsonl", index: 0 },
    context,
  );
  eventHandlers.get("task:subagent:lifecycle")?.(
    { id: "child-1", status: "completed", sessionFile: "/tmp/omp-child-1.jsonl", index: 0 },
    context,
  );
  eventHandlers.get("task:subagent:event")?.({
    id: "child-2",
    event: { type: "agent_start" },
  });
  eventHandlers.get("task:subagent:event")?.({
    id: "child-2",
    event: { type: "agent_end" },
  });

  const deadline = Date.now() + 1_000;
  while (
    Date.now() < deadline &&
    requests.filter((request) => isRecord(request) && request.method === "pane.report_metadata").length < 5
  ) {
    await Bun.sleep(5);
  }

  const methods = requests
    .filter(isRecord)
    .map((request) => request.method);
  expect(methods.indexOf("pane.report_agent_session")).toBeLessThan(
    methods.indexOf("pane.report_agent"),
  );
  const metadata = requests
    .filter((request) => isRecord(request) && request.method === "pane.report_metadata")
    .map((request) => (isRecord(request) ? request.params : undefined));
  expect(metadata).toContainEqual(
    expect.objectContaining({
      title: "Named OMP session",
      tokens: expect.objectContaining({
        omp_context_used: "12.5",
        omp_context_window: "100",
        omp_context_percent: "12.5",
      }),
    }),
  );
  const activeSubagentCounts = metadata.flatMap((params) => {
    if (!isRecord(params) || !isRecord(params.tokens)) {
      return [];
    }
    const count = params.tokens.omp_active_subagents;
    return typeof count === "string" ? [count] : [];
  });
  expect(activeSubagentCounts[0]).toBe("0");
  expect(activeSubagentCounts).toContain("1");
  expect(activeSubagentCounts.at(-1)).toBe("0");
});

test("Oh My Pi fallback progress uses stable IDs and preserves terminal state", async () => {
  const requests = await startRecordingServer("omp-progress-fallback");
  const { handlers, eventHandlers, pi } = createExtensionHarness();
  const { default: install } = await importFresh("./omp/herdr-agent-state.ts");
  install(pi);

  const context = {
    hasUI: true,
    isIdle: () => false,
    sessionManager: {
      getSessionFile: () => "/tmp/omp-progress-session.jsonl",
      getSessionId: () => "omp-progress-session",
    },
  };
  await handlers.get("agent_start")?.({}, context);
  const progress = eventHandlers.get("task:subagent:progress");
  progress?.({
    sessionFile: "/tmp/omp-progress-child.jsonl",
    index: 0,
    progress: { id: "child-progress", status: "running" },
  }, context);
  progress?.({
    sessionFile: "/tmp/omp-progress-child.jsonl",
    index: 0,
    progress: { id: "child-progress", status: "completed" },
  }, context);
  progress?.({
    sessionFile: "/tmp/omp-progress-child.jsonl",
    index: 1,
    progress: { id: "child-progress", status: "running" },
  }, context);

  const deadline = Date.now() + 1_000;
  while (
    Date.now() < deadline &&
    requests.filter((request) => isRecord(request) && request.method === "pane.report_metadata").length <
      3
  ) {
    await Bun.sleep(5);
  }
  const activeSubagentCounts = requests
    .filter((request) => isRecord(request) && request.method === "pane.report_metadata")
    .flatMap((request) => {
      const params = isRecord(request) ? request.params : undefined;
      const tokens = isRecord(params) ? params.tokens : undefined;
      const count = isRecord(tokens) ? tokens.omp_active_subagents : undefined;
      return typeof count === "string" ? [count] : [];
    });
  expect(activeSubagentCounts).toEqual(["0", "1", "0"]);
});

test("Oh My Pi preserves work through blocked and auto-retry transitions", async () => {
  const requests = await startRecordingServer("omp-blocked-retry");
  process.env.HERDR_OMP_IDLE_DEBOUNCE_MS = "0";
  const { handlers, pi } = createExtensionHarness();
  const { default: install } = await importFresh("./omp/herdr-agent-state.ts");
  install(pi);
  const context = {
    hasUI: true,
    isIdle: () => false,
    sessionManager: { getSessionId: () => "omp-session" },
  };

  await handlers.get("agent_start")?.({}, context);
  await handlers.get("tool_approval_requested")?.({ reason: "Approve" }, context);

  const blockedDeadline = Date.now() + 1_000;
  while (
    Date.now() < blockedDeadline &&
    !requests.some((request) => requestState(request) === "blocked")
  ) {
    await Bun.sleep(5);
  }
  await handlers.get("tool_approval_resolved")?.({}, context);
  await handlers.get("auto_retry_start")?.({}, context);
  await handlers.get("auto_retry_end")?.({}, context);

  const deadline = Date.now() + 1_000;
  while (
    Date.now() < deadline &&
    requests.filter((request) => requestState(request) === "working").length < 2
  ) {
    await Bun.sleep(5);
  }
  const states = requests.map(requestState).filter(Boolean);
  expect(states).toContain("blocked");
  expect(states.filter((state) => state === "working").length).toBeGreaterThanOrEqual(2);
  expect(states).not.toContain("idle");
});


function requestState(request: unknown): unknown {
  if (!isRecord(request) || !isRecord(request.params)) {
    return undefined;
  }
  return request.params.state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
