use std::collections::HashMap;

use ratatui::{
    style::{Modifier, Style},
    text::Span,
};

use crate::app::state::Palette;

use super::super::text::display_width;

const CONTEXT_PERCENT_KEY: &str = "omp_context_percent";
const CONTEXT_USED_KEY: &str = "omp_context_used";
const CONTEXT_WINDOW_KEY: &str = "omp_context_window";
const ACTIVE_SUBAGENTS_KEY: &str = "omp_active_subagents";
const MOUTH_TICK_DIVISOR: u32 = 8;
const OPEN_MOUTH: &str = "ᗧ";
const CLOSED_MOUTH: &str = "●";
const GHOST: &str = "ᗣ";
const PELLET: &str = "·";
const LABEL_METER_GAP: &str = " ";
const TELEMETRY_GAP: &str = "  ";
const MIN_METER_CELLS: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ContextUsage {
    display_percent: i64,
    position_basis_points: u16,
}

impl ContextUsage {
    fn from_percent(percent: f64) -> Option<Self> {
        if !percent.is_finite() || percent < i64::MIN as f64 || percent > i64::MAX as f64 {
            return None;
        }
        Some(Self {
            display_percent: percent.round() as i64,
            position_basis_points: (percent.clamp(0.0, 100.0) * 100.0).round() as u16,
        })
    }

    fn label(self) -> String {
        format!("ctx {}%", self.display_percent)
    }
}

fn finite_number(value: Option<&String>) -> Option<f64> {
    value?
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

pub(super) fn context_usage(tokens: &HashMap<String, String>) -> Option<ContextUsage> {
    finite_number(tokens.get(CONTEXT_PERCENT_KEY))
        .and_then(ContextUsage::from_percent)
        .or_else(|| {
            let used = finite_number(tokens.get(CONTEXT_USED_KEY))?;
            let window = finite_number(tokens.get(CONTEXT_WINDOW_KEY))?;
            (used >= 0.0 && window > 0.0)
                .then_some(used / window * 100.0)
                .and_then(ContextUsage::from_percent)
        })
}

pub(super) fn active_subagents(tokens: &HashMap<String, String>) -> Option<usize> {
    tokens.get(ACTIVE_SUBAGENTS_KEY)?.trim().parse().ok()
}

pub(super) fn context_min_width(context: ContextUsage) -> usize {
    display_width(&context.label()) + display_width(LABEL_METER_GAP) + MIN_METER_CELLS
}

fn render_context(
    context: ContextUsage,
    width: usize,
    spinner_tick: u32,
    working: bool,
    palette: &Palette,
) -> Vec<Span<'static>> {
    if width < context_min_width(context) {
        return Vec::new();
    }

    let label = context.label();
    let meter_width = width
        .saturating_sub(display_width(&label))
        .saturating_sub(display_width(LABEL_METER_GAP));
    let last = meter_width.saturating_sub(1);
    let position = last.saturating_mul(context.position_basis_points as usize) / 10_000;
    let pacman = if working && (spinner_tick / MOUTH_TICK_DIVISOR) % 2 == 1 {
        CLOSED_MOUTH
    } else {
        OPEN_MOUTH
    };

    let mut spans = vec![
        Span::styled(label, Style::default().fg(palette.overlay0)),
        Span::raw(LABEL_METER_GAP),
        Span::raw(" ".repeat(position)),
        Span::styled(pacman, Style::default().fg(palette.yellow)),
    ];
    if position < last {
        let pellet_count = last.saturating_sub(position + 1);
        if pellet_count > 0 {
            spans.push(Span::styled(
                PELLET.repeat(pellet_count),
                Style::default()
                    .fg(palette.overlay0)
                    .add_modifier(Modifier::DIM),
            ));
        }
        spans.push(Span::styled(GHOST, Style::default().fg(palette.mauve)));
    }
    spans
}

pub(super) fn render_telemetry(
    context: Option<ContextUsage>,
    subagents: Option<usize>,
    max_width: usize,
    spinner_tick: u32,
    working: bool,
    palette: &Palette,
) -> Vec<Span<'static>> {
    let counter = subagents.map(|count| format!("agents:{count}"));
    let counter_width = counter.as_deref().map(display_width).unwrap_or_default();
    let gap_width = display_width(TELEMETRY_GAP);

    if let Some(context) = context {
        let reserved_width = gap_width.saturating_add(counter_width);
        let minimum = context_min_width(context).saturating_add(reserved_width);
        if counter.is_some() && max_width >= minimum {
            let context_width = max_width.saturating_sub(reserved_width);
            let mut spans = render_context(context, context_width, spinner_tick, working, palette);
            spans.push(Span::raw(TELEMETRY_GAP));
            spans.push(Span::styled(
                counter.expect("counter is present when its width is reserved"),
                Style::default()
                    .fg(palette.overlay0)
                    .add_modifier(Modifier::DIM),
            ));
            return spans;
        }

        if max_width >= context_min_width(context) {
            return render_context(context, max_width, spinner_tick, working, palette);
        }
    }

    if let Some(counter) = counter {
        if counter_width <= max_width {
            return vec![Span::styled(
                counter,
                Style::default()
                    .fg(palette.overlay0)
                    .add_modifier(Modifier::DIM),
            )];
        }
    }

    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(spans: &[Span<'_>]) -> String {
        spans.iter().map(|span| span.content.as_ref()).collect()
    }

    fn usage(percent: f64) -> ContextUsage {
        ContextUsage::from_percent(percent).expect("finite context percentage")
    }

    #[test]
    fn pacman_moves_right_and_clamps_only_its_position() {
        let palette = Palette::catppuccin();
        let zero = text(&render_telemetry(
            Some(usage(0.0)),
            None,
            14,
            0,
            true,
            &palette,
        ));
        let near_full = text(&render_telemetry(
            Some(usage(99.9)),
            None,
            14,
            0,
            true,
            &palette,
        ));
        let over_full = text(&render_telemetry(
            Some(usage(125.0)),
            None,
            14,
            0,
            true,
            &palette,
        ));

        assert!(zero.starts_with("ctx 0% ᗧ"), "zero frame: {zero:?}");
        assert!(
            near_full.starts_with("ctx 100% "),
            "near-full frame: {near_full:?}"
        );
        assert!(near_full.ends_with("ᗧᗣ"), "near-full frame: {near_full:?}");
        assert!(
            over_full.starts_with("ctx 125% "),
            "over-full frame: {over_full:?}"
        );
        assert!(over_full.ends_with('ᗧ'), "over-full frame: {over_full:?}");
        assert!(!over_full.contains('ᗣ'));
    }

    #[test]
    fn meter_animates_only_while_working() {
        let palette = Palette::catppuccin();
        let open = text(&render_telemetry(
            Some(usage(25.0)),
            None,
            14,
            0,
            true,
            &palette,
        ));
        let closed = text(&render_telemetry(
            Some(usage(25.0)),
            None,
            14,
            8,
            true,
            &palette,
        ));
        let idle_a = text(&render_telemetry(
            Some(usage(25.0)),
            None,
            14,
            0,
            false,
            &palette,
        ));
        let idle_b = text(&render_telemetry(
            Some(usage(25.0)),
            None,
            14,
            8,
            false,
            &palette,
        ));

        assert!(open.contains(OPEN_MOUTH));
        assert!(closed.contains(CLOSED_MOUTH));
        assert_eq!(idle_a, idle_b);
    }

    #[test]
    fn narrow_layout_prioritizes_the_context_meter() {
        let palette = Palette::catppuccin();
        let wide = text(&render_telemetry(
            Some(usage(42.0)),
            Some(2),
            24,
            0,
            true,
            &palette,
        ));
        let minimum_sidebar = text(&render_telemetry(
            Some(usage(42.0)),
            Some(2),
            14,
            0,
            true,
            &palette,
        ));
        let minimum_sidebar_zero_agents = text(&render_telemetry(
            Some(usage(42.0)),
            Some(0),
            14,
            0,
            true,
            &palette,
        ));
        let context_only = text(&render_telemetry(
            Some(usage(42.0)),
            None,
            10,
            0,
            true,
            &palette,
        ));
        let counter_only = text(&render_telemetry(
            Some(usage(12_500.0)),
            Some(2),
            8,
            0,
            true,
            &palette,
        ));
        let empty = text(&render_telemetry(
            Some(usage(42.0)),
            Some(2),
            4,
            0,
            true,
            &palette,
        ));

        assert!(wide.contains("agents:2"));
        assert!(minimum_sidebar.contains(OPEN_MOUTH));
        assert!(!minimum_sidebar.contains("agents:"));
        assert_eq!(minimum_sidebar_zero_agents, minimum_sidebar);
        assert!(context_only.contains(OPEN_MOUTH));
        assert_eq!(counter_only, "agents:2");
        assert!(empty.is_empty());
    }

    #[test]
    fn metadata_parsing_falls_back_safely_and_preserves_explicit_zero() {
        let fallback = HashMap::from([
            (CONTEXT_PERCENT_KEY.into(), "not-a-number".into()),
            (CONTEXT_USED_KEY.into(), "25".into()),
            (CONTEXT_WINDOW_KEY.into(), "100".into()),
            (ACTIVE_SUBAGENTS_KEY.into(), "0".into()),
        ]);
        assert_eq!(context_usage(&fallback), Some(usage(25.0)));
        assert_eq!(active_subagents(&fallback), Some(0));

        let malformed = HashMap::from([
            (CONTEXT_USED_KEY.into(), "25".into()),
            (CONTEXT_WINDOW_KEY.into(), "0".into()),
            (ACTIVE_SUBAGENTS_KEY.into(), "many".into()),
        ]);
        assert_eq!(context_usage(&malformed), None);
        assert_eq!(active_subagents(&malformed), None);
        assert_eq!(active_subagents(&HashMap::new()), None);
    }
}
