//! DeepSeek model + reasoning effort selection.
//!
//! cetus ships a single model — DeepSeek V4 Pro — so the only per-conversation
//! axis users tune is reasoning effort (none / high / max). `DsModel` is kept as
//! a one-variant enum so the model id stays a typed value threaded through pi /
//! persistence rather than a bare string, and so re-introducing a second tier
//! later is a localized change.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DsModel {
    Pro,
}

impl DsModel {
    /// Identifier accepted by the DeepSeek chat completions endpoint.
    pub fn api_id(self) -> &'static str {
        match self {
            DsModel::Pro => "deepseek-v4-pro",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            DsModel::Pro => "pro",
        }
    }

    /// Parse a persisted model string. Only "pro" is recognised now; any legacy
    /// value (e.g. a pre-migration "flash") returns None so callers fall back to
    /// the Pro default.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
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

    /// pi's `set_thinking_level` token. pi internally maps `xhigh` → DeepSeek's
    /// `reasoning_effort=max` via the model's `thinkingLevelMap`, so we don't
    /// translate that ourselves.
    pub fn pi_level(self) -> &'static str {
        match self {
            ReasoningLevel::NonThink => "off",
            ReasoningLevel::ThinkHigh => "high",
            ReasoningLevel::ThinkMax => "xhigh",
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
