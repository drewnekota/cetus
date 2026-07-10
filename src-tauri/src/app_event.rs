use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AppEvent {
    PiReady {
        #[serde(rename = "conversationId", skip_serializing_if = "Option::is_none")]
        conversation_id: Option<String>,
    },
    PiExited {
        #[serde(rename = "conversationId", skip_serializing_if = "Option::is_none")]
        conversation_id: Option<String>,
        code: Option<i32>,
    },
    PiError {
        #[serde(rename = "conversationId", skip_serializing_if = "Option::is_none")]
        conversation_id: Option<String>,
        message: String,
    },
    PiEvent {
        #[serde(rename = "conversationId", skip_serializing_if = "Option::is_none")]
        conversation_id: Option<String>,
        event: Value,
    },
    /// A conversation row changed out-of-band (e.g. async auto-titling landed).
    /// The frontend merges `conversation` into its sidebar list.
    ConversationUpdated {
        conversation: crate::store::Conversation,
    },
    /// An automation's state advanced (scheduled next-run computed, enabled
    /// toggled, run recorded). The frontend merges `automation` into its list.
    AutomationUpdated {
        automation: crate::automation::Automation,
    },
    /// An automation was deleted out-of-band (e.g. via the control socket).
    /// The frontend drops it from its list.
    AutomationDeleted { id: String },
    /// An automation fired and minted a conversation. The frontend merges the
    /// updated automation and adds the fresh conversation to its lists.
    AutomationFired {
        automation: crate::automation::Automation,
        conversation: crate::store::Conversation,
    },
    /// Agent memory changed out-of-band. The Memory settings page reloads the
    /// store when it sees this.
    MemoryUpdated,
    /// Agent skills changed out-of-band. The Skills settings page reloads the
    /// store when it sees this.
    SkillsUpdated,
    /// MCP servers changed out-of-band. The MCP settings page reloads the store
    /// when it sees this.
    McpUpdated,
    /// The Ultra Code in-process runtime (`ultra-runtime.ts`) is asking the host
    /// to run one sub-agent. Internal: the frontend ignores this event type.
    UltraAgentRequest {
        #[serde(rename = "conversationId")]
        conversation_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        params: Value,
    },
    /// One browser/computer-use action executed for the frontend's agent-control
    /// card. The model never receives this; it is for the human watcher only.
    AgentStep {
        #[serde(rename = "conversationId")]
        conversation_id: String,
        surface: String,
        action: String,
        #[serde(rename = "highlightedIndex", skip_serializing_if = "Option::is_none")]
        highlighted_index: Option<u32>,
        #[serde(rename = "screenshotJpeg", skip_serializing_if = "Option::is_none")]
        screenshot_jpeg: Option<String>,
    },
    /// Internal: an agent-control extension is tunneling a request to the host.
    AgentControlRequest {
        #[serde(rename = "conversationId")]
        conversation_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        kind: String,
        params: Value,
    },
    /// Internal: the automation-tools extension is asking the host to create,
    /// list, or update a scheduled automation on the agent's behalf.
    AutomationToolRequest {
        #[serde(rename = "conversationId")]
        conversation_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        params: Value,
    },
    /// Internal: the skill-tools extension is asking the host to create, list,
    /// update, or delete a skill on the agent's behalf.
    SkillToolRequest {
        #[serde(rename = "conversationId")]
        conversation_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        params: Value,
    },
    /// Internal: the MCP tools extension is asking the host to create, list,
    /// update, enable/disable, or remove an MCP server on the agent's behalf.
    McpToolRequest {
        #[serde(rename = "conversationId")]
        conversation_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        params: Value,
    },
}

impl From<crate::bridge::RuntimeEvent> for AppEvent {
    fn from(event: crate::bridge::RuntimeEvent) -> Self {
        use crate::bridge::{HostTunnelKind, RuntimeEvent};

        match event {
            RuntimeEvent::Ready { conversation_id } => Self::PiReady { conversation_id },
            RuntimeEvent::Exited {
                conversation_id,
                code,
            } => Self::PiExited {
                conversation_id,
                code,
            },
            RuntimeEvent::Error {
                conversation_id,
                message,
            } => Self::PiError {
                conversation_id,
                message,
            },
            RuntimeEvent::Protocol {
                conversation_id,
                event,
            } => Self::PiEvent {
                conversation_id,
                event,
            },
            RuntimeEvent::HostTunnelRequest {
                conversation_id,
                request_id,
                kind,
                params,
            } => match kind {
                HostTunnelKind::UltraAgent => Self::UltraAgentRequest {
                    conversation_id,
                    request_id,
                    params,
                },
                HostTunnelKind::Automation => Self::AutomationToolRequest {
                    conversation_id,
                    request_id,
                    params,
                },
                HostTunnelKind::Mcp => Self::McpToolRequest {
                    conversation_id,
                    request_id,
                    params,
                },
                HostTunnelKind::Skill => Self::SkillToolRequest {
                    conversation_id,
                    request_id,
                    params,
                },
                HostTunnelKind::AgentStep | HostTunnelKind::Cua | HostTunnelKind::Browser => {
                    Self::AgentControlRequest {
                        conversation_id,
                        request_id,
                        kind: kind.agent_control_label().unwrap_or("unknown").to_string(),
                        params,
                    }
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::{HostTunnelKind, RuntimeEvent};
    use serde_json::json;

    #[test]
    fn maps_runtime_protocol_event_to_pi_event() {
        let event = AppEvent::from(RuntimeEvent::Protocol {
            conversation_id: Some("conv-1".to_string()),
            event: json!({ "type": "message_delta" }),
        });

        match event {
            AppEvent::PiEvent {
                conversation_id,
                event,
            } => {
                assert_eq!(conversation_id.as_deref(), Some("conv-1"));
                assert_eq!(event["type"], "message_delta");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn maps_runtime_tunnel_event_to_product_request() {
        let event = AppEvent::from(RuntimeEvent::HostTunnelRequest {
            conversation_id: "conv-1".to_string(),
            request_id: "req-1".to_string(),
            kind: HostTunnelKind::Automation,
            params: json!({ "op": "list" }),
        });

        match event {
            AppEvent::AutomationToolRequest {
                conversation_id,
                request_id,
                params,
            } => {
                assert_eq!(conversation_id, "conv-1");
                assert_eq!(request_id, "req-1");
                assert_eq!(params["op"], "list");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn maps_agent_control_tunnel_kind_to_string_label() {
        let event = AppEvent::from(RuntimeEvent::HostTunnelRequest {
            conversation_id: "conv-1".to_string(),
            request_id: "req-1".to_string(),
            kind: HostTunnelKind::Browser,
            params: json!({ "url": "https://example.com" }),
        });

        match event {
            AppEvent::AgentControlRequest { kind, .. } => {
                assert_eq!(kind, "browser");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }
}
