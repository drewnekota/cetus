//! WebKit experimental-feature switches for our WKWebViews.
//!
//! macOS 26's WebKit already implements CSS `corner-shape` (Apple-style
//! continuous "squircle" corners) but ships it behind the
//! `CSSCornerShapeEnabled` experimental flag, so `CSS.supports` reports false
//! in a stock WKWebView. Flipping the flag on the webview's own WKPreferences
//! takes effect for the current page load (verified 2026-09-14 on macOS
//! 26.6.2: enabling after `loadHTMLString` still yields `supports=true` at
//! didFinish). The frontend gates its `corner-shape` rule behind `@supports`,
//! so on WebKits without the flag (or without the feature at all) everything
//! silently stays on plain round corners.
//!
//! macOS 27 regressed that implementation: the flag and the parser are still
//! there (`CSS.supports` says yes, `round` still serializes as
//! `superellipse(1)`), but painting only handles the exact endpoints —
//! `superellipse(1)` (round) and the square/`notch` extremes. Every other
//! superellipse, `squircle` and `bevel` included, paints as a plain rectangle,
//! so our global `superellipse(1.6)` wiped out *every* border-radius in the
//! app (verified 2026-09-15 on macOS 27.0 / build 26A428 with a standalone
//! WKWebView snapshot). Since the CSS is `@supports`-gated, simply not
//! flipping the flag there puts the whole UI back on plain round corners.

#[cfg(target_os = "macos")]
const EXPERIMENTAL_FEATURES: &[&str] = &["CSSCornerShapeEnabled"];

/// macOS majors whose WebKit paints `corner-shape: superellipse()` correctly.
/// Re-test and widen this when a later WebKit fixes the painting regression.
#[cfg(target_os = "macos")]
const CORNER_SHAPE_MACOS_MAJORS: std::ops::RangeInclusive<i64> = 26..=26;

/// Inline plugin: enables [`EXPERIMENTAL_FEATURES`] on every webview as it
/// comes up. No-op off macOS.
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("webkit-prefs")
        .on_webview_ready(|webview| {
            #[cfg(target_os = "macos")]
            enable_experimental_features(&webview);
            #[cfg(not(target_os = "macos"))]
            let _ = webview;
        })
        .build()
}

#[cfg(target_os = "macos")]
fn enable_experimental_features<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    let major = macos_major_version();
    if !CORNER_SHAPE_MACOS_MAJORS.contains(&major) {
        tracing::debug!(
            "webview {}: macOS {major} paints corner-shape superellipses as squares, leaving \
             WebKit experimental features off",
            webview.label()
        );
        return;
    }
    let label = webview.label().to_owned();
    let sent = webview.with_webview(move |pw| {
        let enabled = unsafe { set_experimental_features(pw.inner() as *mut _) };
        if enabled.len() != EXPERIMENTAL_FEATURES.len() {
            tracing::warn!(
                "webview {label}: enabled WebKit experimental features {enabled:?}, wanted {EXPERIMENTAL_FEATURES:?}"
            );
        } else {
            tracing::debug!("webview {label}: enabled WebKit experimental features {enabled:?}");
        }
    });
    if let Err(err) = sent {
        tracing::warn!(
            "webview {}: could not reach WKWebView to set experimental features: {err}",
            webview.label()
        );
    }
}

/// Walks `+[WKPreferences _experimentalFeatures]` and calls
/// `-[WKPreferences _setEnabled:forExperimentalFeature:]` for each wanted key.
/// Returns the keys that were found and enabled. Both selectors are WebKit
/// SPI; `AnyClass::get` keeps a missing class from aborting the process.
#[cfg(target_os = "macos")]
unsafe fn set_experimental_features(wk: *mut objc2::runtime::AnyObject) -> Vec<&'static str> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use std::ffi::CStr;
    use std::os::raw::c_char;

    let mut enabled = Vec::new();
    let Some(cls) = AnyClass::get(c"WKPreferences") else {
        return enabled;
    };
    // `-[WKWebView configuration]` hands back a copy, but the copy shares the
    // live WKPreferences object, so toggles here reach the running page.
    let config: *mut AnyObject = msg_send![wk, configuration];
    let prefs: *mut AnyObject = msg_send![config, preferences];
    let features: *mut AnyObject = msg_send![cls, _experimentalFeatures];
    if config.is_null() || prefs.is_null() || features.is_null() {
        return enabled;
    }
    let count: usize = msg_send![features, count];
    for i in 0..count {
        let feature: *mut AnyObject = msg_send![features, objectAtIndex: i];
        let key: *mut AnyObject = msg_send![feature, key];
        if key.is_null() {
            continue;
        }
        let utf8: *const c_char = msg_send![key, UTF8String];
        if utf8.is_null() {
            continue;
        }
        let key = CStr::from_ptr(utf8).to_bytes();
        if let Some(wanted) = EXPERIMENTAL_FEATURES.iter().find(|k| k.as_bytes() == key) {
            let _: () = msg_send![prefs, _setEnabled: Bool::YES, forExperimentalFeature: feature];
            enabled.push(*wanted);
        }
    }
    enabled
}

/// Major version of the running macOS (e.g. `27` for 27.0), or `-1` if
/// `NSProcessInfo` is somehow unreachable — which keeps us on the safe,
/// feature-off path.
#[cfg(target_os = "macos")]
fn macos_major_version() -> i64 {
    objc2_foundation::NSProcessInfo::processInfo()
        .operatingSystemVersion()
        .majorVersion as i64
}
