//! DeepSeek model + reasoning effort selection.
//!
//! cetus ships two DeepSeek V4 tiers — Flash (fast, cheap) and Pro (full
//! capability) — and a per-conversation reasoning-effort axis (off / high /
//! max). Both tiers are advertised by the bundled pi runtime's model registry
//! (`deepseek-v4-flash` / `deepseek-v4-pro`), and `set_model` fails loudly if a
//! runtime can't provide the picked id, so an unsupported combo degrades to a
//! visible error rather than a silent fallback.

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

    /// Parse a persisted model string. Unknown values (e.g. a legacy or
    /// out-of-catalog id) return None so callers fall back to the Pro default.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "flash" => Some(DsModel::Flash),
            "pro" => Some(DsModel::Pro),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningLevel {
    NonThink,
    ThinkHigh,
    ThinkMax,
}

impl ReasoningLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            ReasoningLevel::NonThink => "non_think",
            ReasoningLevel::ThinkHigh => "think_high",
            ReasoningLevel::ThinkMax => "think_max",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "non_think" => Some(ReasoningLevel::NonThink),
            "think_high" => Some(ReasoningLevel::ThinkHigh),
            "think_max" => Some(ReasoningLevel::ThinkMax),
            _ => None,
        }
    }

    /// pi's `set_thinking_level` token. The DeepSeek V4 models' `thinkingLevelMap`
    /// in the bundled runtime accepts exactly `off` / `high` / `max` (all other
    /// levels map to null = unsupported), so we translate directly to those.
    pub fn pi_level(self) -> &'static str {
        match self {
            ReasoningLevel::NonThink => "off",
            ReasoningLevel::ThinkHigh => "high",
            ReasoningLevel::ThinkMax => "max",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub model: DsModel,
    pub reasoning: ReasoningLevel,
}

impl Default for ModelChoice {
    /// Pro with high thinking — the everyday default. Users can drop to NonThink
    /// (faster) or raise to ThinkMax per conversation.
    fn default() -> Self {
        Self {
            model: DsModel::Pro,
            reasoning: ReasoningLevel::ThinkHigh,
        }
    }
}
