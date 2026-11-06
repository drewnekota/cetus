//! Global shortcuts, autostart, notifications, dialogs, etc. Each one forwards
//! to the matching Electron API through a host call.

use serde_json::json;

use crate::{AppHandle, Result};

pub mod global_shortcut {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    use super::*;

    /// Interned accelerator (Copy + Eq).
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub struct Shortcut(u32);

    struct Table {
        by_accel: HashMap<String, u32>,
        accels: Vec<String>,
    }

    fn table() -> &'static Mutex<Table> {
        static T: OnceLock<Mutex<Table>> = OnceLock::new();
        T.get_or_init(|| {
            Mutex::new(Table {
                by_accel: HashMap::new(),
                accels: Vec::new(),
            })
        })
    }

    fn normalize_part(p: &str) -> Option<String> {
        let lower = p.to_ascii_lowercase();
        Some(match lower.as_str() {
            "cmd" | "command" | "super" | "meta" => "Command".into(),
            "ctrl" | "control" => "Control".into(),
            "cmdorctrl" | "commandorcontrol" => "CommandOrControl".into(),
            "alt" | "option" => "Alt".into(),
            "shift" => "Shift".into(),
            _ => {
                let key = p
                    .strip_prefix("Key")
                    .or_else(|| p.strip_prefix("Digit"))
                    .filter(|k| !k.is_empty())
                    .unwrap_or(p);
                if key.is_empty() {
                    return None;
                }
                if key.len() == 1 {
                    key.to_ascii_uppercase()
                } else {
                    key.to_string()
                }
            }
        })
    }

    impl std::str::FromStr for Shortcut {
        type Err = String;
        fn from_str(s: &str) -> std::result::Result<Self, String> {
            let parts: Vec<String> = s
                .split('+')
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(|p| normalize_part(p).ok_or_else(|| format!("bad accelerator part {p:?}")))
                .collect::<std::result::Result<_, _>>()?;
            if parts.is_empty() {
                return Err("empty accelerator".into());
            }
            let accel = parts.join("+");
            let mut t = table().lock().unwrap();
            if let Some(id) = t.by_accel.get(&accel) {
                return Ok(Shortcut(*id));
            }
            let id = t.accels.len() as u32;
            t.accels.push(accel.clone());
            t.by_accel.insert(accel, id);
            Ok(Shortcut(id))
        }
    }

    impl Shortcut {
        pub fn accelerator(&self) -> String {
            table().lock().unwrap().accels[self.0 as usize].clone()
        }
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum ShortcutState {
        Pressed,
        Released,
    }

    #[derive(Debug, Clone, Copy)]
    pub struct ShortcutEvent {
        state: ShortcutState,
    }
    impl ShortcutEvent {
        pub fn state(&self) -> ShortcutState {
            self.state
        }
    }

    type Handler = Box<dyn Fn(&AppHandle, &Shortcut, ShortcutEvent) + Send + Sync>;
    static HANDLER: OnceLock<Handler> = OnceLock::new();

    pub fn set_handler(f: impl Fn(&AppHandle, &Shortcut, ShortcutEvent) + Send + Sync + 'static) {
        let _ = HANDLER.set(Box::new(f));
    }

    /// Called by the addon when Electron fires a registered accelerator.
    pub fn dispatch(app: &AppHandle, accelerator: &str) {
        let Ok(sc) = accelerator.parse::<Shortcut>() else {
            return;
        };
        if let Some(h) = HANDLER.get() {
            h(
                app,
                &sc,
                ShortcutEvent {
                    state: ShortcutState::Pressed,
                },
            );
        }
    }

    pub struct GlobalShortcut<'a>(&'a AppHandle);

    impl GlobalShortcut<'_> {
        pub fn register(&self, sc: Shortcut) -> Result<()> {
            let ok = self
                .0
                .host_call(
                    "shortcut_register",
                    json!({ "accelerator": sc.accelerator() }),
                )
                .map(|v| v.as_bool().unwrap_or(true))
                .unwrap_or(true);
            if ok {
                Ok(())
            } else {
                Err(crate::Error(format!(
                    "could not register {} (already taken?)",
                    sc.accelerator()
                )))
            }
        }
        pub fn unregister_all(&self) -> Result<()> {
            let _ = self.0.host_call("shortcut_unregister_all", json!({}));
            Ok(())
        }
    }

    pub trait GlobalShortcutExt {
        fn global_shortcut(&self) -> GlobalShortcut<'_>;
    }
    impl GlobalShortcutExt for AppHandle {
        fn global_shortcut(&self) -> GlobalShortcut<'_> {
            GlobalShortcut(self)
        }
    }
}

pub mod autostart {
    use super::*;

    pub struct AutoLaunch<'a>(&'a AppHandle);

    impl AutoLaunch<'_> {
        pub fn enable(&self) -> Result<()> {
            let _ = self
                .0
                .host_call("set_login_item", json!({ "enabled": true }));
            Ok(())
        }
        pub fn disable(&self) -> Result<()> {
            let _ = self
                .0
                .host_call("set_login_item", json!({ "enabled": false }));
            Ok(())
        }
    }

    pub trait ManagerExt {
        fn autolaunch(&self) -> AutoLaunch<'_>;
    }
    impl ManagerExt for AppHandle {
        fn autolaunch(&self) -> AutoLaunch<'_> {
            AutoLaunch(self)
        }
    }
}

pub mod notification {
    use super::*;

    pub struct Notification<'a>(&'a AppHandle);
    impl<'a> Notification<'a> {
        pub fn builder(&self) -> NotificationBuilder<'a> {
            NotificationBuilder {
                app: self.0,
                title: String::new(),
                body: String::new(),
            }
        }
    }

    pub struct NotificationBuilder<'a> {
        app: &'a AppHandle,
        title: String,
        body: String,
    }
    impl NotificationBuilder<'_> {
        pub fn title(mut self, t: impl Into<String>) -> Self {
            self.title = t.into();
            self
        }
        pub fn body(mut self, b: impl Into<String>) -> Self {
            self.body = b.into();
            self
        }
        pub fn show(self) -> Result<()> {
            let _ = self
                .app
                .host_call("notify", json!({ "title": self.title, "body": self.body }));
            Ok(())
        }
    }

    pub trait NotificationExt {
        fn notification(&self) -> Notification<'_>;
    }
    impl NotificationExt for AppHandle {
        fn notification(&self) -> Notification<'_> {
            Notification(self)
        }
    }
}

pub mod dialog {
    use std::path::PathBuf;

    use super::*;

    pub struct FilePath(PathBuf);
    impl FilePath {
        pub fn into_path(self) -> std::result::Result<PathBuf, crate::Error> {
            Ok(self.0)
        }
    }

    pub struct Dialog<'a>(&'a AppHandle);
    impl<'a> Dialog<'a> {
        pub fn file(&self) -> FileDialog<'a> {
            FileDialog {
                app: self.0,
                name: None,
            }
        }
        pub fn message(&self, body: impl Into<String>) -> MessageDialog<'a> {
            MessageDialog {
                app: self.0,
                body: body.into(),
                title: String::new(),
                buttons: MessageDialogButtons::Ok,
            }
        }
    }

    pub struct FileDialog<'a> {
        app: &'a AppHandle,
        name: Option<String>,
    }
    impl FileDialog<'_> {
        pub fn set_file_name(mut self, n: impl Into<String>) -> Self {
            self.name = Some(n.into());
            self
        }
        pub fn pick_folder(self, f: impl FnOnce(Option<FilePath>) + Send + 'static) {
            self.app
                .host_call_then("dialog_pick_folder", json!({}), move |v| {
                    f(v.as_str().map(|s| FilePath(s.into())))
                });
        }
        pub fn save_file(self, f: impl FnOnce(Option<FilePath>) + Send + 'static) {
            self.app
                .host_call_then("dialog_save_file", json!({ "name": self.name }), move |v| {
                    f(v.as_str().map(|s| FilePath(s.into())))
                });
        }
    }

    pub enum MessageDialogKind {
        Info,
        Warning,
        Error,
    }
    pub enum MessageDialogButtons {
        Ok,
        OkCancelCustom(String, String),
    }

    pub struct MessageDialog<'a> {
        app: &'a AppHandle,
        body: String,
        title: String,
        buttons: MessageDialogButtons,
    }
    impl MessageDialog<'_> {
        pub fn title(mut self, t: impl Into<String>) -> Self {
            self.title = t.into();
            self
        }
        pub fn kind(self, _k: MessageDialogKind) -> Self {
            self
        }
        pub fn buttons(mut self, b: MessageDialogButtons) -> Self {
            self.buttons = b;
            self
        }
        pub fn show(self, f: impl FnOnce(bool) + Send + 'static) {
            let buttons = match self.buttons {
                MessageDialogButtons::Ok => vec!["OK".to_string()],
                MessageDialogButtons::OkCancelCustom(a, b) => vec![a, b],
            };
            self.app.host_call_then(
                "dialog_message",
                json!({ "title": self.title, "body": self.body, "buttons": buttons }),
                move |v| f(v.as_u64() == Some(0)),
            );
        }
    }

    pub trait DialogExt {
        fn dialog(&self) -> Dialog<'_>;
    }
    impl DialogExt for AppHandle {
        fn dialog(&self) -> Dialog<'_> {
            Dialog(self)
        }
    }
}

/// Self-update. The Electron build has no update feed yet, so `check`
/// always reports "up to date"; the types keep the backend's update flow
/// compiling unchanged until the Electron release pipeline exists.
pub mod updater {
    pub use crate::updater::*;
}
