use super::screen_recording_granted;
#[cfg(target_os = "macos")]
use super::CGRequestScreenCaptureAccess;

#[tauri::command]
pub async fn accessibility_trusted() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(crate::hotkey::is_trusted(false))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

/// Trigger the system Accessibility prompt (adds cetus to the list) and report
/// current trust.
#[tauri::command]
pub async fn request_accessibility() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(crate::hotkey::is_trusted(true))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

#[tauri::command]
pub async fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn screen_recording_trusted() -> Result<bool, String> {
    Ok(screen_recording_granted())
}

/// Trigger the system Screen Recording prompt. The grant only takes effect for
/// `screencapture` after the prompt is accepted (sometimes after a relaunch).
#[tauri::command]
pub async fn request_screen_recording() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(unsafe { CGRequestScreenCaptureAccess() })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

#[tauri::command]
pub async fn open_screen_recording_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Full Disk Access has no preflight API. Probe by opening a file macOS only
/// lets FDA-holders read: the per-user TCC database. Without FDA the open
/// fails with EPERM (and does *not* trigger any prompt).
#[cfg(target_os = "macos")]
fn full_disk_access_granted() -> bool {
    let Some(home) = std::env::var_os("HOME") else {
        return false;
    };
    let db =
        std::path::PathBuf::from(home).join("Library/Application Support/com.apple.TCC/TCC.db");
    std::fs::File::open(db).is_ok()
}

/// Whether cetus (and every agent CLI it spawns — macOS attributes child
/// processes to the app) can read other apps' sandbox containers without the
/// per-app "would like to access data from other apps" prompt.
#[tauri::command]
pub async fn full_disk_access_trusted() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(full_disk_access_granted())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

/// There is no system prompt for Full Disk Access; the only "request" is to
/// deep-link the user into the Privacy pane so they can toggle cetus on.
#[tauri::command]
pub async fn open_full_disk_access_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
