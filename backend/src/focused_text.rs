//! Unified focused-editor context for dictation and correction learning.
//!
//! macOS text surfaces expose several incompatible Accessibility shapes:
//! native controls use `AXValue` + `AXSelectedTextRange`, Chromium/Electron
//! rich editors use opaque `AXTextMarkerRange`s, and some custom/canvas UIs
//! expose no editable text at all. This module hides that ladder behind one
//! cursor-aware snapshot shared by ASR context and the correction watcher.

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusedTextSnapshot {
    pub app: String,
    pub bundle_id: String,
    pub pid: i32,
    pub role: String,
    pub subrole: String,
    pub identifier: String,
    /// Coarse element geometry, used only as a fallback identity when the app
    /// does not expose AXIdentifier. Rounded to absorb tiny layout shifts.
    pub frame_key: String,
    pub before: String,
    pub selected: String,
    pub after: String,
    /// `value-range`, `text-marker`, `value`, `subtree`, or `screen-ocr`.
    pub source: String,
}

impl FocusedTextSnapshot {
    pub fn text(&self) -> String {
        format!("{}{}{}", self.before, self.selected, self.after)
    }

    /// Context nearest the insertion point, balanced around the caret rather
    /// than blindly taking the end of a potentially long document.
    pub fn nearby(&self, max_chars: usize) -> String {
        if max_chars == 0 {
            return String::new();
        }
        let selected_len = self.selected.chars().count().min(max_chars);
        let remaining = max_chars.saturating_sub(selected_len);
        let before_budget = remaining / 2 + remaining % 2;
        let after_budget = remaining / 2;
        let before: String = self
            .before
            .chars()
            .rev()
            .take(before_budget)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let selected: String = self.selected.chars().take(selected_len).collect();
        let after: String = self.after.chars().take(after_budget).collect();
        format!("{before}{selected}{after}").trim().to_string()
    }

    pub fn same_target(&self, other: &Self) -> bool {
        if self.pid != other.pid || self.bundle_id != other.bundle_id {
            return false;
        }
        if !self.identifier.is_empty() && !other.identifier.is_empty() {
            return self.identifier == other.identifier;
        }
        self.role == other.role
            && self.subrole == other.subrole
            && (self.frame_key.is_empty()
                || other.frame_key.is_empty()
                || self.frame_key == other.frame_key)
    }
}

/// Capture the focused text surface. When `allow_ocr` is true, a local screen
/// OCR snapshot is returned only after every AX strategy fails. OCR has no
/// reliable caret or field identity, so its whole result sits in `before` and
/// callers must treat it as lower-confidence evidence.
pub fn capture(
    app_data_dir: &Path,
    max_chars: usize,
    allow_ocr: bool,
) -> Option<FocusedTextSnapshot> {
    #[cfg(target_os = "macos")]
    {
        crate::ax::wake_frontmost_app();
        if let Some(snapshot) = capture_ax(max_chars) {
            return Some(snapshot);
        }
        // Never turn an unreadable secure field into a full-screen OCR read.
        // AX password controls intentionally hide their value; OCR must respect
        // that boundary rather than bypass it.
        if allow_ocr && !focused_is_secure() {
            let (app, bundle_id, pid) = crate::ax::frontmost_identity().unwrap_or_default();
            let text = crate::capture::ocr_screen_now(app_data_dir)?;
            let text = tail_chars(text.trim(), max_chars.max(1));
            if !text.is_empty() {
                return Some(FocusedTextSnapshot {
                    app,
                    bundle_id,
                    pid,
                    role: String::new(),
                    subrole: String::new(),
                    identifier: String::new(),
                    frame_key: String::new(),
                    before: text,
                    selected: String::new(),
                    after: String::new(),
                    source: "screen-ocr".to_string(),
                });
            }
        }
        None
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app_data_dir, max_chars, allow_ocr);
        None
    }
}

fn tail_chars(text: &str, max_chars: usize) -> String {
    text.chars()
        .rev()
        .take(max_chars)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

#[cfg(target_os = "macos")]
fn capture_ax(max_chars: usize) -> Option<FocusedTextSnapshot> {
    let (app_name, bundle_id, pid) = crate::ax::frontmost_identity()?;
    capture_ax_for(app_name, bundle_id, pid, max_chars)
}

/// Diagnostic/test entry point for a known application process. Production
/// callers use [`capture`], but targeting a PID lets the dev bridge verify apps
/// driven through AX automation even when that automation does not make the
/// window the real NSWorkspace frontmost application.
#[cfg(target_os = "macos")]
pub(crate) fn capture_pid(
    app_name: String,
    bundle_id: String,
    pid: i32,
    max_chars: usize,
) -> Option<FocusedTextSnapshot> {
    crate::ax::wake_app(pid);
    capture_ax_for(app_name, bundle_id, pid, max_chars)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn capture_pid(
    _app_name: String,
    _bundle_id: String,
    _pid: i32,
    _max_chars: usize,
) -> Option<FocusedTextSnapshot> {
    None
}

#[cfg(target_os = "macos")]
fn capture_ax_for(
    app_name: String,
    bundle_id: String,
    pid: i32,
    max_chars: usize,
) -> Option<FocusedTextSnapshot> {
    use accessibility_sys::{
        AXIsProcessTrusted, AXUIElementCreateApplication, AXUIElementRef,
        AXUIElementSetMessagingTimeout,
    };
    use core_foundation::base::{CFType, CFTypeRef, TCFType};

    if !unsafe { AXIsProcessTrusted() } {
        return None;
    }
    if pid <= 0 {
        return None;
    }
    unsafe {
        let app_ref = AXUIElementCreateApplication(pid);
        if app_ref.is_null() {
            return None;
        }
        let app = CFType::wrap_under_create_rule(app_ref as CFTypeRef);
        let app_el = app.as_CFTypeRef() as AXUIElementRef;
        AXUIElementSetMessagingTimeout(app_el, 0.25);
        let focused = copy_attr(app_el, "AXFocusedUIElement")?;
        let el = focused.as_CFTypeRef() as AXUIElementRef;
        AXUIElementSetMessagingTimeout(el, 0.25);

        let role = copy_string(el, "AXRole").unwrap_or_default();
        let subrole = copy_string(el, "AXSubrole").unwrap_or_default();
        if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
            return None;
        }
        let identifier = copy_string(el, "AXIdentifier")
            .or_else(|| copy_string(el, "AXDOMIdentifier"))
            .unwrap_or_default();
        let frame_key = frame_key(el);

        let value = copy_string(el, "AXValue");
        let (before, selected, after, source) =
            if let (Some(value), Some(range)) = (value.as_deref(), selected_range(el)) {
                let (before, selected, after) = split_utf16_range(value, range.0, range.1);
                (before, selected, after, "value-range")
            } else if let Some(parts) = text_marker_parts(el) {
                // Chromium/Electron frequently exposes AXValue but omits the
                // standard selected range. TextMarker is stronger than guessing
                // that the caret sits at the end, so try it before the weak value
                // fallback.
                (parts.0, parts.1, parts.2, "text-marker")
            } else if let Some(value) = value {
                // Some controls expose a selection string but no range. Preserve
                // it when it is unambiguous; otherwise the caret is conservatively
                // treated as the end of the value.
                let selected = copy_string(el, "AXSelectedText").unwrap_or_default();
                if !selected.is_empty() && value.matches(&selected).count() == 1 {
                    let at = value.find(&selected).unwrap_or(value.len());
                    (
                        value[..at].to_string(),
                        selected.clone(),
                        value[at + selected.len()..].to_string(),
                        "value",
                    )
                } else {
                    (value, String::new(), String::new(), "value")
                }
            } else {
                if !matches!(
                    role.as_str(),
                    "AXTextArea"
                        | "AXTextField"
                        | "AXComboBox"
                        | "AXWebArea"
                        | "AXGroup"
                        | "AXGenericElement"
                ) {
                    return None;
                }
                let text = gather_subtree(el, max_chars.saturating_mul(2).max(512))?;
                (text, String::new(), String::new(), "subtree")
            };

        let mut snapshot = FocusedTextSnapshot {
            app: app_name,
            bundle_id,
            pid,
            role,
            subrole,
            identifier,
            frame_key,
            before,
            selected,
            after,
            source: source.to_string(),
        };
        bound_parts(&mut snapshot, max_chars.max(1));
        if snapshot.text().trim().is_empty() {
            None
        } else {
            Some(snapshot)
        }
    }
}

#[cfg(target_os = "macos")]
fn focused_is_secure() -> bool {
    use accessibility_sys::{
        AXIsProcessTrusted, AXUIElementCreateApplication, AXUIElementRef,
        AXUIElementSetMessagingTimeout,
    };
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    if !unsafe { AXIsProcessTrusted() } {
        // Without AX trust we cannot prove the surface is safe to OCR.
        return true;
    }
    let Some((_, _, pid)) = crate::ax::frontmost_identity() else {
        return true;
    };
    unsafe {
        let raw = AXUIElementCreateApplication(pid);
        if raw.is_null() {
            return true;
        }
        let owner = CFType::wrap_under_create_rule(raw as CFTypeRef);
        let app = owner.as_CFTypeRef() as AXUIElementRef;
        AXUIElementSetMessagingTimeout(app, 0.2);
        let Some(focused) = copy_attr(app, "AXFocusedUIElement") else {
            // An app with no readable focus may still be a canvas/editor; allow
            // OCR. Password fields normally expose a secure AX role even while
            // withholding their value.
            return false;
        };
        let el = focused.as_CFTypeRef() as AXUIElementRef;
        let role = copy_string(el, "AXRole").unwrap_or_default();
        let subrole = copy_string(el, "AXSubrole").unwrap_or_default();
        role == "AXSecureTextField" || subrole == "AXSecureTextField"
    }
}

#[cfg(target_os = "macos")]
unsafe fn copy_attr(
    el: accessibility_sys::AXUIElementRef,
    name: &str,
) -> Option<core_foundation::base::CFType> {
    use accessibility_sys::{kAXErrorSuccess, AXUIElementCopyAttributeValue};
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::string::CFString;
    let key = CFString::new(name);
    let mut out: CFTypeRef = std::ptr::null_mut();
    let err = AXUIElementCopyAttributeValue(el, key.as_concrete_TypeRef(), &mut out);
    if err != kAXErrorSuccess || out.is_null() {
        None
    } else {
        Some(CFType::wrap_under_create_rule(out))
    }
}

#[cfg(target_os = "macos")]
unsafe fn copy_param(
    el: accessibility_sys::AXUIElementRef,
    name: &str,
    parameter: core_foundation::base::CFTypeRef,
) -> Option<core_foundation::base::CFType> {
    use accessibility_sys::{kAXErrorSuccess, AXUIElementCopyParameterizedAttributeValue};
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::string::CFString;
    let key = CFString::new(name);
    let mut out: CFTypeRef = std::ptr::null_mut();
    let err = AXUIElementCopyParameterizedAttributeValue(
        el,
        key.as_concrete_TypeRef(),
        parameter,
        &mut out,
    );
    if err != kAXErrorSuccess || out.is_null() {
        None
    } else {
        Some(CFType::wrap_under_create_rule(out))
    }
}

#[cfg(target_os = "macos")]
unsafe fn copy_string(el: accessibility_sys::AXUIElementRef, name: &str) -> Option<String> {
    use core_foundation::base::{CFGetTypeID, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    let value = copy_attr(el, name)?;
    if CFGetTypeID(value.as_CFTypeRef()) != CFString::type_id() {
        return None;
    }
    Some(CFString::wrap_under_get_rule(value.as_CFTypeRef() as CFStringRef).to_string())
}

#[cfg(target_os = "macos")]
unsafe fn type_string(value: &core_foundation::base::CFType) -> Option<String> {
    use core_foundation::base::{CFGetTypeID, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    if CFGetTypeID(value.as_CFTypeRef()) != CFString::type_id() {
        return None;
    }
    Some(CFString::wrap_under_get_rule(value.as_CFTypeRef() as CFStringRef).to_string())
}

#[cfg(target_os = "macos")]
unsafe fn selected_range(el: accessibility_sys::AXUIElementRef) -> Option<(usize, usize)> {
    use accessibility_sys::{kAXValueTypeCFRange, AXValueGetType, AXValueGetValue, AXValueRef};
    use core_foundation::base::CFRange;
    use core_foundation::base::TCFType;
    let value = copy_attr(el, "AXSelectedTextRange")?;
    let ax_value = value.as_CFTypeRef() as AXValueRef;
    if AXValueGetType(ax_value) != kAXValueTypeCFRange {
        return None;
    }
    let mut range = CFRange {
        location: 0,
        length: 0,
    };
    if !AXValueGetValue(
        ax_value,
        kAXValueTypeCFRange,
        &mut range as *mut _ as *mut std::ffi::c_void,
    ) || range.location < 0
        || range.length < 0
    {
        return None;
    }
    Some((range.location as usize, range.length as usize))
}

#[cfg(target_os = "macos")]
unsafe fn text_marker_parts(
    el: accessibility_sys::AXUIElementRef,
) -> Option<(String, String, String)> {
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};

    let full = copy_param(el, "AXTextMarkerRangeForUIElement", el as _)?;
    let selected = copy_attr(el, "AXSelectedTextMarkerRange")?;
    let full_start = copy_param(
        el,
        "AXStartTextMarkerForTextMarkerRange",
        full.as_CFTypeRef(),
    )?;
    let full_end = copy_param(el, "AXEndTextMarkerForTextMarkerRange", full.as_CFTypeRef())?;
    let selected_start = copy_param(
        el,
        "AXStartTextMarkerForTextMarkerRange",
        selected.as_CFTypeRef(),
    )?;
    let selected_end = copy_param(
        el,
        "AXEndTextMarkerForTextMarkerRange",
        selected.as_CFTypeRef(),
    )?;

    let range = |a: &CFType, b: &CFType| -> Option<CFType> {
        let markers = CFArray::<CFType>::from_CFTypes(&[a.clone(), b.clone()]);
        copy_param(
            el,
            "AXTextMarkerRangeForUnorderedTextMarkers",
            markers.as_CFTypeRef(),
        )
    };
    let text = |r: &CFType| -> Option<String> {
        type_string(&copy_param(
            el,
            "AXStringForTextMarkerRange",
            r.as_CFTypeRef(),
        )?)
    };
    let before = text(&range(&full_start, &selected_start)?)?;
    let selected_text = text(&selected).unwrap_or_default();
    let after = text(&range(&selected_end, &full_end)?)?;
    Some((before, selected_text, after))
}

#[cfg(target_os = "macos")]
unsafe fn frame_key(el: accessibility_sys::AXUIElementRef) -> String {
    use accessibility_sys::{
        kAXValueTypeCGPoint, kAXValueTypeCGSize, AXValueGetType, AXValueGetValue, AXValueRef,
    };
    use core_foundation::base::TCFType;
    use core_graphics::geometry::{CGPoint, CGSize};
    let Some(position) = copy_attr(el, "AXPosition") else {
        return String::new();
    };
    let Some(size) = copy_attr(el, "AXSize") else {
        return String::new();
    };
    let pv = position.as_CFTypeRef() as AXValueRef;
    let sv = size.as_CFTypeRef() as AXValueRef;
    if AXValueGetType(pv) != kAXValueTypeCGPoint || AXValueGetType(sv) != kAXValueTypeCGSize {
        return String::new();
    }
    let mut point = CGPoint::new(0.0, 0.0);
    let mut dims = CGSize::new(0.0, 0.0);
    if !AXValueGetValue(
        pv,
        kAXValueTypeCGPoint,
        &mut point as *mut _ as *mut std::ffi::c_void,
    ) || !AXValueGetValue(
        sv,
        kAXValueTypeCGSize,
        &mut dims as *mut _ as *mut std::ffi::c_void,
    ) {
        return String::new();
    }
    // Height commonly changes for auto-growing textareas while the user edits;
    // position + width form a more stable field identity.
    format!("{:.0},{:.0},{:.0}", point.x, point.y, dims.width)
}

#[cfg(target_os = "macos")]
unsafe fn gather_subtree(
    el: accessibility_sys::AXUIElementRef,
    max_chars: usize,
) -> Option<String> {
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};
    let mut out = String::new();
    let mut stack: Vec<(CFType, usize)> = vec![(CFType::wrap_under_get_rule(el as _), 0)];
    let mut visited = 0usize;
    while let Some((owner, depth)) = stack.pop() {
        if visited >= 300 || depth > 8 || out.chars().count() >= max_chars {
            break;
        }
        visited += 1;
        let node = owner.as_CFTypeRef() as accessibility_sys::AXUIElementRef;
        accessibility_sys::AXUIElementSetMessagingTimeout(node, 0.2);
        let role = copy_string(node, "AXRole").unwrap_or_default();
        let subrole = copy_string(node, "AXSubrole").unwrap_or_default();
        if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
            continue;
        }
        if let Some(value) = copy_string(node, "AXValue")
            .or_else(|| copy_string(node, "AXTitle"))
            .filter(|s| !s.trim().is_empty())
        {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(value.trim());
            continue;
        }
        if let Some(children) = copy_attr(node, "AXChildren") {
            if children.instance_of::<CFArray<CFType>>() {
                let array: CFArray<CFType> = CFArray::wrap_under_get_rule(
                    children.as_CFTypeRef() as core_foundation::array::CFArrayRef
                );
                let items: Vec<CFType> = array.iter().map(|v| v.clone()).collect();
                for item in items.into_iter().rev() {
                    stack.push((item, depth + 1));
                }
            }
        }
    }
    let text = out.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn split_utf16_range(value: &str, location: usize, length: usize) -> (String, String, String) {
    let start = utf16_offset_to_byte(value, location);
    let end = utf16_offset_to_byte(value, location.saturating_add(length));
    (
        value[..start].to_string(),
        value[start..end].to_string(),
        value[end..].to_string(),
    )
}

fn utf16_offset_to_byte(value: &str, wanted: usize) -> usize {
    if wanted == 0 {
        return 0;
    }
    let mut units = 0usize;
    for (byte, ch) in value.char_indices() {
        if units >= wanted {
            return byte;
        }
        units += ch.len_utf16();
        if units >= wanted {
            return byte + ch.len_utf8();
        }
    }
    value.len()
}

fn bound_parts(snapshot: &mut FocusedTextSnapshot, max_chars: usize) {
    let selected_len = snapshot.selected.chars().count().min(max_chars);
    let remaining = max_chars.saturating_sub(selected_len);
    let before_budget = remaining / 2 + remaining % 2;
    let after_budget = remaining / 2;
    snapshot.before = tail_chars(&snapshot.before, before_budget);
    snapshot.selected = snapshot.selected.chars().take(selected_len).collect();
    snapshot.after = snapshot.after.chars().take(after_budget).collect();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_ax_utf16_ranges_without_breaking_emoji() {
        let parts = split_utf16_range("ab😀中文cd", 2, 3);
        assert_eq!(parts, ("ab".into(), "😀中".into(), "文cd".into()));
    }

    #[test]
    fn nearby_balances_around_caret() {
        let snapshot = FocusedTextSnapshot {
            app: String::new(),
            bundle_id: String::new(),
            pid: 1,
            role: "AXTextArea".into(),
            subrole: String::new(),
            identifier: String::new(),
            frame_key: String::new(),
            before: "0123456789".into(),
            selected: "XX".into(),
            after: "abcdefghij".into(),
            source: "value-range".into(),
        };
        assert_eq!(snapshot.nearby(10), "6789XXabcd");
    }
}
