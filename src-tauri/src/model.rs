//! Model + reasoning effort selection for the built-in pi runtime.
//!
//! cetus ships two DeepSeek V4 tiers — Flash (fast, cheap) and Pro (full
//! capability) — plus any number of user-configured custom OpenAI-compatible
//! models (see `custom_models.rs`). A conversation's choice is persisted as a
//! single string: `"flash"` / `"pro"` for the built-ins, or
//! `"<provider>/<model-id>"` for a custom model (custom provider ids always
//! carry the `custom-` prefix, so the two forms can't collide). The
//! per-conversation reasoning axis (off / high / max) applies to the DeepSeek
//! built-ins natively, and to custom models that declare a reasoning knob
//! (their High/Max tokens map through pi's thinkingLevelMap; see
//! `custom_models.rs` and `model_bridge.rs`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DsModel {
    Flash,
    Pro,
}

impl DsModel {
    /// Identifier accepted by the DeepSeek chat completions endpoint.
    pub fn api_id(self) -> &'static str {
        match self {
            DsModel::Flash => "deepseek-v4-flash",
            DsModel::Pro => "deepseek-v4-pro",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            DsModel::Flash => "flash",
            DsModel::Pro => "pro",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "flash" => Some(DsModel::Flash),
            "pro" => Some(DsModel::Pro),
            _ => None,
        }
    }
}

/// Which model a conversation runs on: a built-in DeepSeek tier, or a
/// user-configured custom provider's model. Serialized (both to the DB and
/// over IPC) as the plain string form — `"pro"` or `"custom-foo/gpt-4o"` —
/// so the frontend deals in strings and old persisted rows parse unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelRef {
    Builtin(DsModel),
    Custom { provider: String, model: String },
}

impl ModelRef {
    /// Parse a persisted / IPC model string. Unknown values (a legacy or
    /// out-of-catalog id) return None so callers fall back to the Pro default.
    pub fn parse(s: &str) -> Option<Self> {
        if let Some(m) = DsModel::parse(s) {
            return Some(ModelRef::Builtin(m));
        }
        // Custom form: "<provider>/<model>". Model ids may themselves contain
        // '/' (e.g. OpenRouter's "anthropic/claude..."), so split on the FIRST.
        let (provider, model) = s.split_once('/')?;
        if provider.is_empty() || model.is_empty() {
            return None;
        }
        Some(ModelRef::Custom {
            provider: provider.to_string(),
            model: model.to_string(),
        })
    }

    pub fn to_persist(&self) -> String {
        match self {
            ModelRef::Builtin(m) => m.as_str().to_string(),
            ModelRef::Custom { provider, model } => format!("{provider}/{model}"),
        }
    }
}

impl Default for ModelRef {
    fn default() -> Self {
        ModelRef::Builtin(DsModel::Pro)
    }
}

impl Serialize for ModelRef {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_persist())
    }
}

impl<'de> Deserialize<'de> for ModelRef {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        ModelRef::parse(&s).ok_or_else(|| serde::de::Error::custom(format!("unknown model: {s}")))
    }
}

/// The full pi thinking-level axis. Custom models expose whichever subset
/// they map (Settings → Models); the DeepSeek built-ins support off/high/max
/// and clamp the rest (see [`ReasoningLevel::builtin_pi_level`]).
///
/// Persisted (DB + IPC) as the pi level name. The pre-custom-models cetus
/// releases persisted `non_think` / `think_high` / `think_max`; those parse
/// as aliases forever so old rows and localStorage survive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ReasoningLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
    Max,
}

impl ReasoningLevel {
    /// All levels, in pi's escalation order (mirrors EXTENDED_THINKING_LEVELS
    /// in the bundled runtime; clamping walks this order).
    pub const ALL: [ReasoningLevel; 7] = [
        ReasoningLevel::Off,
        ReasoningLevel::Minimal,
        ReasoningLevel::Low,
        ReasoningLevel::Medium,
        ReasoningLevel::High,
        ReasoningLevel::XHigh,
        ReasoningLevel::Max,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ReasoningLevel::Off => "off",
            ReasoningLevel::Minimal => "minimal",
            ReasoningLevel::Low => "low",
            ReasoningLevel::Medium => "medium",
            ReasoningLevel::High => "high",
            ReasoningLevel::XHigh => "xhigh",
            ReasoningLevel::Max => "max",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "off" | "non_think" => Some(ReasoningLevel::Off),
            "minimal" => Some(ReasoningLevel::Minimal),
            "low" => Some(ReasoningLevel::Low),
            "medium" => Some(ReasoningLevel::Medium),
            "high" | "think_high" => Some(ReasoningLevel::High),
            "xhigh" => Some(ReasoningLevel::XHigh),
            "max" | "think_max" => Some(ReasoningLevel::Max),
            _ => None,
        }
    }

    /// pi's `set_thinking_level` token — the level name itself.
    pub fn pi_level(self) -> &'static str {
        self.as_str()
    }

    /// The level actually sent for the DeepSeek built-ins, whose bundled
    /// thinkingLevelMap supports exactly off / high / max: mid-tier levels
    /// clamp to the only "on" tier below Max, xhigh clamps to max.
    pub fn builtin_pi_level(self) -> &'static str {
        match self {
            ReasoningLevel::Off => "off",
            ReasoningLevel::Minimal
            | ReasoningLevel::Low
            | ReasoningLevel::Medium
            | ReasoningLevel::High => "high",
            ReasoningLevel::XHigh | ReasoningLevel::Max => "max",
        }
    }
}

impl Serialize for ReasoningLevel {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ReasoningLevel {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        ReasoningLevel::parse(&s)
            .ok_or_else(|| serde::de::Error::custom(format!("unknown reasoning level: {s}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub model: ModelRef,
    pub reasoning: ReasoningLevel,
}

impl Default for ModelChoice {
    /// Pro with high thinking — the everyday default. Users can drop to Off
    /// (faster) or raise per conversation.
    fn default() -> Self {
        Self {
            model: ModelRef::default(),
            reasoning: ReasoningLevel::High,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_builtin_and_custom_forms() {
        assert_eq!(
            ModelRef::parse("pro"),
            Some(ModelRef::Builtin(DsModel::Pro))
        );
        assert_eq!(
            ModelRef::parse("custom-openrouter/anthropic/claude-sonnet-4"),
            Some(ModelRef::Custom {
                provider: "custom-openrouter".into(),
                model: "anthropic/claude-sonnet-4".into(),
            })
        );
        assert_eq!(ModelRef::parse("garbage"), None);
        assert_eq!(ModelRef::parse("/no-provider"), None);
    }

    #[test]
    fn reasoning_levels_parse_with_legacy_aliases() {
        for (legacy, level) in [
            ("non_think", ReasoningLevel::Off),
            ("think_high", ReasoningLevel::High),
            ("think_max", ReasoningLevel::Max),
        ] {
            assert_eq!(ReasoningLevel::parse(legacy), Some(level));
        }
        for level in ReasoningLevel::ALL {
            assert_eq!(ReasoningLevel::parse(level.as_str()), Some(level));
        }
    }

    #[test]
    fn persist_round_trips() {
        for s in ["flash", "pro", "custom-x/some/model"] {
            assert_eq!(ModelRef::parse(s).unwrap().to_persist(), s);
        }
    }
}
