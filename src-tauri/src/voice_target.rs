//! A local-only insertion guard. AX references identify the actual window and
//! focused element; titles and geometry alone cannot distinguish two editors.
use accessibility_sys::{
    kAXErrorSuccess, AXUIElementCopyAttributeValue, AXUIElementCreateApplication, AXUIElementRef,
    AXUIElementSetMessagingTimeout,
};
use core_foundation::{
    base::{CFType, CFTypeRef, TCFType},
    string::CFString,
};
use std::hash::{Hash, Hasher};

struct AxValue(CFType);
// AX values here are retained, immutable CF objects / remote AX proxies. They
// are never accessed concurrently; ownership moves to/from a blocking worker.
unsafe impl Send for AxValue {}

pub(crate) struct Target {
    pub app: String,
    bundle: String,
    pid: i32,
    window: AxValue,
    field: AxValue,
    selection: Option<AxValue>,
    value_hash: Option<u64>,
    revision: u64,
}

unsafe fn attr(el: AXUIElementRef, name: &str) -> Option<AxValue> {
    let mut value: CFTypeRef = std::ptr::null();
    let name = CFString::new(name);
    if AXUIElementCopyAttributeValue(el, name.as_concrete_TypeRef(), &mut value) != kAXErrorSuccess
        || value.is_null()
    {
        return None;
    }
    Some(AxValue(CFType::wrap_under_create_rule(value)))
}
fn string(value: AxValue) -> Option<String> {
    value.0.downcast::<CFString>().map(|s| s.to_string())
}
fn fingerprint(text: String) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

impl Target {
    pub fn identity(&self) -> (String, i32) {
        (self.bundle.clone(), self.pid)
    }
    /// Do not read screen/OCR, copy selection, or send this baseline to a model.
    /// The frontmost identity is captured before starting the blocking AX read.
    pub fn capture(identity: (String, String, i32), revision: u64) -> Option<Self> {
        let (app, bundle, pid) = identity;
        unsafe {
            let raw = AXUIElementCreateApplication(pid);
            if raw.is_null() {
                return None;
            }
            let _owner = CFType::wrap_under_create_rule(raw as CFTypeRef);
            AXUIElementSetMessagingTimeout(raw, 0.08);
            let window = attr(raw, "AXFocusedWindow")?;
            let field = attr(raw, "AXFocusedUIElement")?;
            let el = field.0.as_CFTypeRef() as AXUIElementRef;
            AXUIElementSetMessagingTimeout(el, 0.08);
            if attr(el, "AXSubrole").and_then(string).as_deref() == Some("AXSecureTextField") {
                return None;
            }
            let selection =
                attr(el, "AXSelectedTextRange").or_else(|| attr(el, "AXSelectedTextMarkerRange"));
            let role = attr(el, "AXRole").and_then(string).unwrap_or_default();
            if selection.is_none()
                && !matches!(
                    role.as_str(),
                    "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField"
                )
            {
                return None;
            }
            let value_hash = attr(el, "AXValue").and_then(string).map(fingerprint);
            Some(Self {
                app,
                bundle,
                pid,
                window,
                field,
                selection,
                value_hash,
                revision,
            })
        }
    }

    pub fn still_focused(&self, revision: u64) -> bool {
        let Some(identity) = crate::ax::frontmost_identity() else {
            return false;
        };
        if identity.2 != self.pid || identity.1 != self.bundle || revision != self.revision {
            return false;
        }
        let Some(now) = Self::capture(identity, revision) else {
            return false;
        };
        self.matches(&now)
            && crate::ax::frontmost_identity()
                .is_some_and(|(_, b, p)| p == self.pid && b == self.bundle)
    }

    fn matches(&self, now: &Self) -> bool {
        let same_selection = match (&self.selection, &now.selection) {
            (Some(a), Some(b)) => a.0 == b.0,
            (None, None) => true,
            _ => false,
        };
        self.identity() == now.identity()
            && self.revision == now.revision
            && self.window.0 == now.window.0
            && self.field.0 == now.field.0
            && same_selection
            && self.value_hash == now.value_hash
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn token(value: &str) -> AxValue {
        AxValue(CFString::new(value).as_CFType())
    }
    fn snapshot() -> Target {
        Target {
            app: "Editor".into(),
            bundle: "editor.test".into(),
            pid: 42,
            window: token("window-1"),
            field: token("field-1"),
            selection: Some(token("caret-10")),
            value_hash: Some(fingerprint("draft".into())),
            revision: 7,
        }
    }
    #[test]
    fn voice_target_rejects_same_app_different_window_or_field() {
        let start = snapshot();
        assert!(start.matches(&snapshot()));
        let mut end = snapshot();
        end.window = token("window-2");
        assert!(!start.matches(&end));
        let mut end = snapshot();
        end.field = token("field-2");
        assert!(!start.matches(&end));
        let mut end = snapshot();
        end.pid += 1;
        assert!(!start.matches(&end));
    }
    #[test]
    fn voice_target_rejects_caret_edits_and_lost_accessibility_evidence() {
        let start = snapshot();
        let mut end = snapshot();
        end.selection = Some(token("caret-11"));
        assert!(!start.matches(&end));
        let mut end = snapshot();
        end.value_hash = Some(fingerprint("edited".into()));
        assert!(!start.matches(&end));
        let mut end = snapshot();
        end.selection = None;
        assert!(!start.matches(&end));
        let mut end = snapshot();
        end.revision += 1; // clicked away and back to same baseline
        assert!(!start.matches(&end));
    }
}
