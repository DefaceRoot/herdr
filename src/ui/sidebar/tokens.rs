use crate::config::{
    AgentSidebarToken, AgentsSidebarConfig, SpaceSidebarToken, SpacesSidebarConfig,
};

use super::AgentPanelEntry;

// Native rows for a canonical OMP pane with no `rows_by_agent.omp` override.
// The canonical agent label is a fallback for the session title: named panes
// show the pane title alone (`OMP_TITLE_ROW`); unnamed panes keep the label so
// the row stays identifiable (`OMP_FALLBACK_ROW`).
const OMP_TITLE_ROW: &[AgentSidebarToken] = &[
    AgentSidebarToken::StateIcon,
    AgentSidebarToken::Pane,
];
const OMP_FALLBACK_ROW: &[AgentSidebarToken] = &[
    AgentSidebarToken::StateIcon,
    AgentSidebarToken::Agent,
];
const OMP_TELEMETRY_ROW: &[AgentSidebarToken] = &[
    AgentSidebarToken::OmpContext,
    AgentSidebarToken::OmpSubagents,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ResolvedToken {
    StateIcon,
    StateText(String),
    Workspace(String),
    Tab(String),
    Pane(String),
    Agent(String),
    TerminalTitle(String),
    Branch(String),
    OmpContext(super::omp::ContextUsage),
    OmpSubagents(usize),
    GitStatus { ahead: usize, behind: usize },
    Custom(String),
}

pub(super) fn agent_rows(
    config: &AgentsSidebarConfig,
    entry: &AgentPanelEntry,
    state_text: &str,
) -> Vec<Vec<ResolvedToken>> {
    if entry.agent == Some(crate::detect::Agent::Omp)
        && !config
            .rows_by_agent
            .contains_key(crate::detect::agent_label(crate::detect::Agent::Omp))
    {
        let label_row = if entry.pane_label.is_some() {
            OMP_TITLE_ROW
        } else {
            OMP_FALLBACK_ROW
        };
        resolve_agent_rows(
            [label_row, OMP_TELEMETRY_ROW].iter().copied(),
            entry,
            state_text,
        )
    } else {
        resolve_agent_rows(
            config.rows_for_agent(entry.agent).iter().map(Vec::as_slice),
            entry,
            state_text,
        )
    }
}

fn resolve_agent_rows<'a>(
    rows: impl IntoIterator<Item = &'a [AgentSidebarToken]>,
    entry: &AgentPanelEntry,
    state_text: &str,
) -> Vec<Vec<ResolvedToken>> {
    rows.into_iter()
        .filter_map(|row| {
            let resolved = row
                .iter()
                .filter_map(|token| match token {
                    AgentSidebarToken::StateIcon => Some(ResolvedToken::StateIcon),
                    AgentSidebarToken::StateText => {
                        Some(ResolvedToken::StateText(state_text.to_string()))
                    }
                    AgentSidebarToken::Workspace => {
                        Some(ResolvedToken::Workspace(entry.primary_label.clone()))
                    }
                    AgentSidebarToken::Tab => {
                        entry.primary_tab_label.clone().map(ResolvedToken::Tab)
                    }
                    AgentSidebarToken::Pane => entry.pane_label.clone().map(ResolvedToken::Pane),
                    AgentSidebarToken::Agent => entry.agent_label.clone().map(ResolvedToken::Agent),
                    AgentSidebarToken::TerminalTitle => entry
                        .terminal_title
                        .clone()
                        .map(ResolvedToken::TerminalTitle),
                    AgentSidebarToken::TerminalTitleStripped => entry
                        .terminal_title_stripped
                        .clone()
                        .map(ResolvedToken::TerminalTitle),
                    AgentSidebarToken::OmpContext
                        if entry.agent == Some(crate::detect::Agent::Omp) =>
                    {
                        super::omp::context_usage(&entry.tokens).map(ResolvedToken::OmpContext)
                    }
                    AgentSidebarToken::OmpSubagents
                        if entry.agent == Some(crate::detect::Agent::Omp) =>
                    {
                        super::omp::active_subagents(&entry.tokens).map(ResolvedToken::OmpSubagents)
                    }
                    AgentSidebarToken::OmpContext | AgentSidebarToken::OmpSubagents => None,
                    AgentSidebarToken::Custom(name) => {
                        entry.tokens.get(name).cloned().map(ResolvedToken::Custom)
                    }
                })
                .collect::<Vec<_>>();
            (!resolved.is_empty()).then_some(resolved)
        })
        .collect()
}

pub(super) struct SpaceTokenContext<'a> {
    pub workspace: &'a str,
    pub branch: Option<&'a str>,
    pub state_text: &'a str,
    pub ahead_behind: Option<(usize, usize)>,
    pub tokens: &'a std::collections::HashMap<String, String>,
    pub suppress_git_details: bool,
}

pub(super) fn space_rows(
    config: &SpacesSidebarConfig,
    context: SpaceTokenContext<'_>,
) -> Vec<Vec<ResolvedToken>> {
    config
        .rows
        .iter()
        .filter_map(|row| {
            let resolved = row
                .iter()
                .filter_map(|token| match token {
                    SpaceSidebarToken::StateIcon => Some(ResolvedToken::StateIcon),
                    SpaceSidebarToken::StateText => {
                        Some(ResolvedToken::StateText(context.state_text.to_string()))
                    }
                    SpaceSidebarToken::Workspace => {
                        Some(ResolvedToken::Workspace(context.workspace.to_string()))
                    }
                    SpaceSidebarToken::Branch if !context.suppress_git_details => context
                        .branch
                        .map(|branch| ResolvedToken::Branch(branch.to_string())),
                    SpaceSidebarToken::Branch => None,
                    SpaceSidebarToken::GitStatus if !context.suppress_git_details => context
                        .ahead_behind
                        .filter(|(ahead, behind)| *ahead > 0 || *behind > 0)
                        .map(|(ahead, behind)| ResolvedToken::GitStatus { ahead, behind }),
                    SpaceSidebarToken::GitStatus => None,
                    SpaceSidebarToken::Custom(name) => {
                        context.tokens.get(name).cloned().map(ResolvedToken::Custom)
                    }
                })
                .collect::<Vec<_>>();
            (!resolved.is_empty()).then_some(resolved)
        })
        .collect()
}

pub(super) fn separator(previous: &ResolvedToken, current: &ResolvedToken) -> &'static str {
    if matches!(previous, ResolvedToken::StateIcon)
        || matches!(current, ResolvedToken::GitStatus { .. })
    {
        " "
    } else if matches!(previous, ResolvedToken::OmpContext(_))
        && matches!(current, ResolvedToken::OmpSubagents(_))
    {
        "  "
    } else {
        " · "
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detect::AgentState;

    fn entry() -> AgentPanelEntry {
        AgentPanelEntry {
            ws_idx: 0,
            tab_idx: 0,
            pane_id: crate::layout::PaneId::from_raw(1),
            primary_label: "repo".into(),
            primary_tab_label: None,
            pane_label: None,
            terminal_title: None,
            terminal_title_stripped: None,
            agent_label: Some("pi".into()),
            agent: Some(crate::detect::Agent::Pi),
            state: AgentState::Working,
            seen: true,
            last_agent_state_change_seq: None,
            state_labels: std::collections::HashMap::new(),
            tokens: std::collections::HashMap::new(),
        }
    }

    #[test]
    fn missing_custom_tokens_elide_rows_and_separators() {
        let entry = entry();
        let config = AgentsSidebarConfig {
            rows: vec![
                vec![
                    AgentSidebarToken::StateIcon,
                    AgentSidebarToken::Custom("missing".into()),
                ],
                vec![AgentSidebarToken::Custom("missing".into())],
                vec![AgentSidebarToken::Agent],
            ],
            ..Default::default()
        };

        let rows = agent_rows(&config, &entry, "working");

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], vec![ResolvedToken::StateIcon]);
        assert_eq!(rows[1], vec![ResolvedToken::Agent("pi".into())]);
    }

    #[test]
    fn state_text_and_arbitrary_values_are_independent_tokens() {
        let mut entry = entry();
        entry
            .tokens
            .insert("summary".into(), "reviewing auth".into());
        let config = AgentsSidebarConfig {
            rows: vec![vec![
                AgentSidebarToken::StateText,
                AgentSidebarToken::Custom("summary".into()),
            ]],
            ..Default::default()
        };

        assert_eq!(
            agent_rows(&config, &entry, "deep in the mines"),
            vec![vec![
                ResolvedToken::StateText("deep in the mines".into()),
                ResolvedToken::Custom("reviewing auth".into()),
            ]]
        );
    }

    #[test]
    fn terminal_title_builtins_are_distinct_from_custom_tokens() {
        let mut entry = entry();
        entry.terminal_title = Some("⠋ raw title".into());
        entry.terminal_title_stripped = Some("raw title".into());
        entry
            .tokens
            .insert("terminal_title".into(), "custom title".into());
        let config = AgentsSidebarConfig {
            rows: vec![vec![
                AgentSidebarToken::TerminalTitle,
                AgentSidebarToken::TerminalTitleStripped,
                AgentSidebarToken::Custom("terminal_title".into()),
            ]],
            ..Default::default()
        };

        assert_eq!(
            agent_rows(&config, &entry, "working"),
            vec![vec![
                ResolvedToken::TerminalTitle("⠋ raw title".into()),
                ResolvedToken::TerminalTitle("raw title".into()),
                ResolvedToken::Custom("custom title".into()),
            ]]
        );
    }

    #[test]
    fn omp_native_tokens_resolve_only_for_canonical_omp() {
        let mut omp = entry();
        omp.agent = Some(crate::detect::Agent::Omp);
        omp.agent_label = Some("omp".into());
        omp.pane_label = Some("Refactor the sidebar".into());
        omp.tokens.extend([
            ("omp_context_percent".into(), "12.5".into()),
            ("omp_active_subagents".into(), "2".into()),
        ]);
        let config = toml::from_str::<crate::config::Config>(
            r#"
[ui.sidebar.agents.rows_by_agent]
claude = [["agent"]]
"#,
        )
        .expect("Claude sidebar override")
        .ui
        .sidebar
        .agents;

        let rows = agent_rows(&config, &omp, "working");
        assert_eq!(
            rows[0],
            vec![
                ResolvedToken::StateIcon,
                ResolvedToken::Pane("Refactor the sidebar".into()),
            ]
        );
        assert_eq!(
            rows[1],
            vec![
                ResolvedToken::OmpContext(
                    crate::ui::sidebar::omp::context_usage(&omp.tokens).unwrap()
                ),
                ResolvedToken::OmpSubagents(2),
            ]
        );

        omp.agent = Some(crate::detect::Agent::Pi);
        assert_eq!(
            agent_rows(&config, &omp, "working"),
            vec![
                vec![
                    ResolvedToken::StateIcon,
                    ResolvedToken::Workspace("repo".into())
                ],
                vec![ResolvedToken::Agent("omp".into())],
            ]
        );

        let mut non_omp_config = AgentsSidebarConfig::default();
        non_omp_config.rows_by_agent.insert(
            "claude".into(),
            vec![vec![
                AgentSidebarToken::OmpContext,
                AgentSidebarToken::OmpSubagents,
            ]],
        );
        omp.agent = Some(crate::detect::Agent::Claude);
        assert_eq!(
            agent_rows(&non_omp_config, &omp, "working"),
            Vec::<Vec<ResolvedToken>>::new()
        );
    }

    #[test]
    fn explicit_omp_override_replaces_the_native_layout() {
        let config = toml::from_str::<crate::config::Config>(
            r#"
[ui.sidebar.agents.rows_by_agent]
omp = [["agent"]]
"#,
        )
        .expect("OMP sidebar override")
        .ui
        .sidebar
        .agents;
        let mut omp = entry();
        omp.agent = Some(crate::detect::Agent::Omp);
        omp.agent_label = Some("omp".into());
        omp.tokens.extend([
            ("omp_context_percent".into(), "12.5".into()),
            ("omp_active_subagents".into(), "2".into()),
        ]);

        assert_eq!(
            agent_rows(&config, &omp, "working"),
            vec![vec![ResolvedToken::Agent("omp".into())]]
        );
    }

    #[test]
    fn omp_missing_or_malformed_telemetry_elides_the_second_row_but_zero_is_visible() {
        let mut omp = entry();
        omp.agent = Some(crate::detect::Agent::Omp);
        omp.pane_label = Some("Session title".into());
        omp.tokens
            .insert("omp_context_percent".into(), "malformed".into());

        assert_eq!(
            agent_rows(&AgentsSidebarConfig::default(), &omp, "working"),
            vec![vec![
                ResolvedToken::StateIcon,
                ResolvedToken::Pane("Session title".into()),
            ]]
        );

        omp.tokens.insert("omp_active_subagents".into(), "0".into());
        assert_eq!(
            agent_rows(&AgentsSidebarConfig::default(), &omp, "working")[1],
            vec![ResolvedToken::OmpSubagents(0)]
        );
        omp.tokens.insert("omp_active_subagents".into(), "3".into());
        assert_eq!(
            agent_rows(&AgentsSidebarConfig::default(), &omp, "working")[1],
            vec![ResolvedToken::OmpSubagents(3)]
        );
    }

    #[test]
    fn known_agent_override_replaces_default_rows() {
        let mut config = AgentsSidebarConfig {
            rows: vec![vec![AgentSidebarToken::Workspace]],
            ..Default::default()
        };
        config
            .rows_by_agent
            .insert("pi".into(), vec![vec![AgentSidebarToken::Agent]]);
        let mut pi = entry();
        pi.agent_label = Some("renamed pi".into());

        assert_eq!(
            agent_rows(&config, &pi, "working"),
            vec![vec![ResolvedToken::Agent("renamed pi".into())]]
        );

        pi.agent = None;
        assert_eq!(
            agent_rows(&config, &pi, "working"),
            vec![vec![ResolvedToken::Workspace("repo".into())]]
        );
    }

    #[test]
    fn grouped_children_suppress_all_builtin_git_details() {
        let config = SpacesSidebarConfig::default();

        assert_eq!(
            space_rows(
                &config,
                SpaceTokenContext {
                    workspace: "feature",
                    branch: Some("worktree/feature"),
                    state_text: "idle",
                    ahead_behind: Some((2, 1)),
                    tokens: &std::collections::HashMap::new(),
                    suppress_git_details: true,
                },
            ),
            vec![vec![
                ResolvedToken::StateIcon,
                ResolvedToken::Workspace("feature".into()),
            ]]
        );
    }

    #[test]
    fn workspace_custom_token_can_replace_git_specific_details() {
        let tokens = std::collections::HashMap::from([("jj_status".into(), "2 changes".into())]);
        let config = SpacesSidebarConfig {
            rows: vec![vec![SpaceSidebarToken::Custom("jj_status".into())]],
            ..Default::default()
        };

        assert_eq!(
            space_rows(
                &config,
                SpaceTokenContext {
                    workspace: "repo",
                    branch: None,
                    state_text: "idle",
                    ahead_behind: None,
                    tokens: &tokens,
                    suppress_git_details: false,
                },
            ),
            vec![vec![ResolvedToken::Custom("2 changes".into())]]
        );
    }
}
