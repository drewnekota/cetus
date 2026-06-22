//! Host/extension bridge protocol shared by the Tauri host and pi extensions.
//!
//! This module is intentionally product-light: it defines the stable tunnel
//! titles, extension directory names, and small classifiers the host uses to
//! distinguish hidden extension RPCs from user-visible UI requests. Product
//! handlers live in `automation_tool`, `mcp_tool`, `skill_tool`, `agent`, and
//! `ultra`.

use serde_json::Value;
use std::collections::BTreeSet;
use std::path::PathBuf;

/// Sentinel `ctx.ui.input` title the Ultra runtime uses to tunnel a sub-agent
/// request to the host.
pub const ULTRA_AGENT_TITLE: &str = "__cetus_ultra_agent__";

/// Sentinel `ctx.ui.input` title used by agent-control extensions to push a live
/// "watch" step to the host UI.
pub const AGENT_STEP_TITLE: &str = "__cetus_agent_step__";

/// Sentinel `ctx.ui.input` title used by computer-use to reach the native macOS
/// accessibility helper.
pub const CUA_REQUEST_TITLE: &str = "__cetus_cua_request__";

/// Sentinel `ctx.ui.input` title used by browser-use to ask the host UI to open
/// or focus the visible browser surface.
pub const BROWSER_REQUEST_TITLE: &str = "__cetus_browser_request__";

/// Sentinel `ctx.ui.input` title used by automation tools to mutate the host
/// automation store.
pub const AUTOMATION_TOOL_TITLE: &str = "__cetus_automation__";

/// Sentinel `ctx.ui.input` title used by skill tools to mutate the host skill
/// store.
pub const SKILL_TOOL_TITLE: &str = "__cetus_skill__";

/// Sentinel `ctx.ui.input` title used by MCP tools to mutate the host MCP store.
pub const MCP_TOOL_TITLE: &str = "__cetus_mcp__";

/// Directory under the pi install tree that contains Cetus-owned extensions.
pub const CETUS_EXTENSIONS_DIR: &str = "cetus-extensions";

/// Former extension directory names. Startup sync prunes these so a rename does
/// not leave stale, loader-ignored tools behind.
pub const LEGACY_EXTENSION_DIRS: &[&str] = &["kott-extensions"];

/// Extensions that must always load for the core bridge surface to work.
pub const CORE_EXTENSIONS: &[&str] = &[
    "automation-tools.ts",
    "memory.ts",
    "mcp-tools.ts",
    "skill-discovery.ts",
    "skill-tools.ts",
    "request-review.ts",
    "mcp-bridge.ts",
];

#[derive(Debug, Clone)]
pub struct ExtensionLoadConfig {
    pub directory_name: &'static str,
    pub required_extensions: &'static [&'static str],
}

impl Default for ExtensionLoadConfig {
    fn default() -> Self {
        Self {
            directory_name: CETUS_EXTENSIONS_DIR,
            required_extensions: CORE_EXTENSIONS,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeConfig {
    pub append_system_prompt: String,
    pub extensions: ExtensionLoadConfig,
    pub plugin_extensions: PluginExtensionConfig,
}

#[derive(Debug, Clone, Default)]
pub struct PluginExtensionConfig {
    pub owned_extension_names: BTreeSet<String>,
    pub extension_paths: Vec<PathBuf>,
    pub runtime_dir: Option<PathBuf>,
    pub enabled_summaries: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostTunnelKind {
    UltraAgent,
    Automation,
    Mcp,
    Skill,
    AgentStep,
    Cua,
    Browser,
}

#[derive(Debug, Clone)]
pub enum RuntimeEvent {
    Ready {
        conversation_id: Option<String>,
    },
    Exited {
        conversation_id: Option<String>,
        code: Option<i32>,
    },
    Error {
        conversation_id: Option<String>,
        message: String,
    },
    Protocol {
        conversation_id: Option<String>,
        event: Value,
    },
    HostTunnelRequest {
        conversation_id: String,
        request_id: String,
        kind: HostTunnelKind,
        params: Value,
    },
}

impl HostTunnelKind {
    pub fn agent_control_label(&self) -> Option<&'static str> {
        match self {
            Self::AgentStep => Some("step"),
            Self::Cua => Some("cua"),
            Self::Browser => Some("browser"),
            _ => None,
        }
    }
}

/// Return the host tunnel kind for hidden `ctx.ui.input` requests.
///
/// Any other extension UI request should flow through to the frontend dialog
/// host as user-visible UI. Keeping this classifier narrow is an important
/// safety boundary: only known sentinel titles get native side effects.
pub fn host_tunnel_kind(value: &Value) -> Option<HostTunnelKind> {
    if value.get("type").and_then(|t| t.as_str()) != Some("extension_ui_request") {
        return None;
    }
    if value.get("method").and_then(|m| m.as_str()) != Some("input") {
        return None;
    }
    match value.get("title").and_then(|t| t.as_str()) {
        Some(ULTRA_AGENT_TITLE) => Some(HostTunnelKind::UltraAgent),
        Some(AUTOMATION_TOOL_TITLE) => Some(HostTunnelKind::Automation),
        Some(MCP_TOOL_TITLE) => Some(HostTunnelKind::Mcp),
        Some(SKILL_TOOL_TITLE) => Some(HostTunnelKind::Skill),
        Some(AGENT_STEP_TITLE) => Some(HostTunnelKind::AgentStep),
        Some(CUA_REQUEST_TITLE) => Some(HostTunnelKind::Cua),
        Some(BROWSER_REQUEST_TITLE) => Some(HostTunnelKind::Browser),
        _ => None,
    }
}

/// Parse the hidden JSON payload carried in an extension `ctx.ui.input`
/// placeholder. Host tunnels use `placeholder` as an opaque transport field
/// because pi's UI RPC already round-trips it.
pub fn tunnel_params(value: &Value) -> Value {
    value
        .get("placeholder")
        .and_then(|p| p.as_str())
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_known_host_tunnels() {
        let req = |title| {
            json!({
                "type": "extension_ui_request",
                "method": "input",
                "title": title,
            })
        };

        assert_eq!(
            host_tunnel_kind(&req(ULTRA_AGENT_TITLE)),
            Some(HostTunnelKind::UltraAgent)
        );
        assert_eq!(
            host_tunnel_kind(&req(AUTOMATION_TOOL_TITLE)),
            Some(HostTunnelKind::Automation)
        );
        assert_eq!(
            host_tunnel_kind(&req(MCP_TOOL_TITLE)),
            Some(HostTunnelKind::Mcp)
        );
        assert_eq!(
            host_tunnel_kind(&req(SKILL_TOOL_TITLE)),
            Some(HostTunnelKind::Skill)
        );
        assert_eq!(
            host_tunnel_kind(&req(AGENT_STEP_TITLE)),
            Some(HostTunnelKind::AgentStep)
        );
        assert_eq!(
            host_tunnel_kind(&req(CUA_REQUEST_TITLE)),
            Some(HostTunnelKind::Cua)
        );
        assert_eq!(
            host_tunnel_kind(&req(BROWSER_REQUEST_TITLE)),
            Some(HostTunnelKind::Browser)
        );
    }

    #[test]
    fn leaves_unknown_or_visible_ui_requests_alone() {
        assert_eq!(
            host_tunnel_kind(&json!({
                "type": "extension_ui_request",
                "method": "select",
                "title": AUTOMATION_TOOL_TITLE,
            })),
            None
        );
        assert_eq!(
            host_tunnel_kind(&json!({
                "type": "extension_ui_request",
                "method": "input",
                "title": "visible prompt",
            })),
            None
        );
    }

    #[test]
    fn parses_json_placeholder_params() {
        assert_eq!(
            tunnel_params(&json!({ "placeholder": "{\"op\":\"list\"}" })),
            json!({ "op": "list" })
        );
        assert_eq!(
            tunnel_params(&json!({ "placeholder": "not json" })),
            Value::Null
        );
    }
}
