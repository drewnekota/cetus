//! OS notifications with click-to-open routing.
//!
//! Posted through the Electron host (`Notification`), which keeps each
//! notification alive until it is clicked or dismissed. A click comes back as
//! the `notification_click` app event ([`activated`]): cetus is brought forward
//! and the UI gets a `notification-activate` event carrying the conversation id
//! the notification was posted for.

use host::{AppHandle, Emitter};

/// Kept for setup's call order; the host owns the notification delegate.
pub fn init(app: &AppHandle) {
    let _ = app;
}

/// Post a notification. `conversation_id`, when present, is echoed back on click
/// so the UI can open (or unarchive) that conversation.
#[host::command]
pub async fn post_notification(
    app: AppHandle,
    title: String,
    body: String,
    conversation_id: Option<String>,
) -> Result<(), String> {
    app.host_call(
        "notify",
        serde_json::json!({ "title": title, "body": body, "conversationId": conversation_id }),
    );
    Ok(())
}

/// A notification was clicked: bring cetus forward (restores a parked main
/// window), then hand the id to the UI to open / unarchive.
pub fn activated(app: &AppHandle, conversation_id: Option<String>) {
    crate::focus_main(app);
    let payload = serde_json::json!({ "conversationId": conversation_id });
    let _ = app.emit_to("main", "notification-activate", payload);
}
