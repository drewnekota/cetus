//! Non-macOS fallback for features that synthesize keyboard input on macOS.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InsertMode {
    Type,
    Paste,
}

impl InsertMode {
    pub fn from_str(s: &str) -> Self {
        match s {
            "paste" => Self::Paste,
            _ => Self::Type,
        }
    }
}

pub fn insert_text(_text: &str, _mode: InsertMode) -> Result<(), String> {
    Err("text insertion is only available on macOS".into())
}

pub(crate) fn copy_selection_via_clipboard() -> Option<String> {
    None
}

pub(crate) fn clipboard_file_paths() -> Vec<String> {
    Vec::new()
}
