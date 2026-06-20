use crate::AppState;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

const HOST_NAME: &str = "com.cetus.chrome_use";
const EXTENSION_ID: &str = "bellidpjmeaomkdjbhkcaokmeflanpmc";
const HOST_ARG: &str = "--chrome-native-host";
const STATE_DIR_ARG: &str = "--state-dir";
const MESSAGES_REL: &str = "chrome-use/messages.jsonl";
const COMMANDS_REL: &str = "chrome-use/commands.jsonl";

type CmdResult<T> = Result<T, String>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeUseStatus {
    installed: bool,
    host_name: String,
    extension_id: String,
    manifest_path: String,
    messages_path: String,
    commands_path: String,
    extension_origin: String,
    last_message: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeUseSelfTest {
    ok: bool,
    message: String,
    ack: Option<Value>,
    logged: Option<Value>,
}

#[tauri::command]
pub async fn install_chrome_native_host(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<ChromeUseStatus> {
    install_native_host_manifest(&app, &state.app_data_dir)?;
    chrome_use_status(state).await
}

#[tauri::command]
pub async fn open_chrome_extensions_page() -> CmdResult<()> {
    open_chrome_url("chrome://extensions")
}

#[tauri::command]
pub async fn test_chrome_native_host(state: State<'_, AppState>) -> CmdResult<ChromeUseSelfTest> {
    native_host_self_test(&state.app_data_dir)
}

#[tauri::command]
pub async fn chrome_use_status(state: State<'_, AppState>) -> CmdResult<ChromeUseStatus> {
    let manifest_path = native_host_manifest_path()?;
    let last_message = read_last_message(&state.app_data_dir);
    Ok(ChromeUseStatus {
        installed: manifest_path.is_file(),
        host_name: HOST_NAME.to_string(),
        extension_id: EXTENSION_ID.to_string(),
        manifest_path: manifest_path.to_string_lossy().into_owned(),
        messages_path: messages_path(&state.app_data_dir)
            .to_string_lossy()
            .into_owned(),
        commands_path: commands_path(&state.app_data_dir)
            .to_string_lossy()
            .into_owned(),
        extension_origin: extension_origin().to_string(),
        last_message,
    })
}

fn open_chrome_url(url: &str) -> CmdResult<()> {
    #[cfg(target_os = "macos")]
    {
        if run_open_command(Command::new("open").args(["-a", "Google Chrome", url])) {
            return Ok(());
        }
        if run_open_command(Command::new("open").arg(url)) {
            return Ok(());
        }
    }
    #[cfg(target_os = "windows")]
    {
        if run_open_command(Command::new("cmd").args(["/C", "start", "chrome", url])) {
            return Ok(());
        }
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        for browser in [
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
        ] {
            if run_open_command(Command::new(browser).arg(url)) {
                return Ok(());
            }
        }
        if run_open_command(Command::new("xdg-open").arg(url)) {
            return Ok(());
        }
    }
    Err("could not open Chrome extensions page".to_string())
}

fn run_open_command(command: &mut Command) -> bool {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub(crate) fn native_host_self_test(app_data_dir: &Path) -> CmdResult<ChromeUseSelfTest> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let test_dir = app_data_dir
        .join("chrome-use")
        .join(format!("self-test-{}", now_ms()));
    fs::create_dir_all(&test_dir).map_err(|e| e.to_string())?;

    let mut child = Command::new(exe)
        .arg(HOST_ARG)
        .arg(STATE_DIR_ARG)
        .arg(&test_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let payload = json!({
        "type": "self_test",
        "source": "cetus",
        "sentAt": now_ms()
    });
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(&native_message_bytes(&payload).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    drop(child.stdin.take());

    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let ack =
        read_native_message_from(&mut Cursor::new(&output.stdout)).map_err(|e| e.to_string())?;
    let logged = read_last_message(&test_dir);
    let _ = fs::remove_dir_all(&test_dir);

    let ok = output.status.success()
        && ack
            .as_ref()
            .and_then(|value| value.get("ok"))
            .and_then(Value::as_bool)
            == Some(true)
        && logged
            .as_ref()
            .and_then(|value| value.get("message"))
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str)
            == Some("self_test");
    let message = if ok {
        "Chrome native host responded and wrote a test message.".to_string()
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            "Chrome native host self-test failed.".to_string()
        } else {
            format!("Chrome native host self-test failed: {stderr}")
        }
    };

    Ok(ChromeUseSelfTest {
        ok,
        message,
        ack,
        logged,
    })
}

pub fn messages_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(MESSAGES_REL)
}

pub fn commands_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(COMMANDS_REL)
}

pub fn maybe_run_native_host_from_args() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|arg| arg == HOST_ARG) {
        return false;
    }
    let state_dir = args
        .windows(2)
        .find_map(|pair| (pair[0] == STATE_DIR_ARG).then(|| PathBuf::from(&pair[1])));
    let Some(state_dir) = state_dir else {
        let _ = write_native_message(&json!({
            "ok": false,
            "error": "missing --state-dir"
        }));
        return true;
    };
    if let Err(e) = run_native_host(&state_dir) {
        let _ = write_native_message(&json!({
            "ok": false,
            "error": e.to_string()
        }));
    }
    true
}

fn install_native_host_manifest(app: &AppHandle, app_data_dir: &Path) -> CmdResult<()> {
    let manifest_path = native_host_manifest_path()?;
    let manifest_dir = manifest_path
        .parent()
        .ok_or_else(|| "native host manifest path has no parent".to_string())?;
    fs::create_dir_all(manifest_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(app_data_dir.join("chrome-use")).map_err(|e| e.to_string())?;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let launcher = write_host_launcher(app_data_dir, &exe)?;
    let manifest = json!({
        "name": HOST_NAME,
        "description": "Cetus Chrome Use native messaging host",
        "path": launcher,
        "type": "stdio",
        "allowed_origins": [extension_origin()]
    });
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let _ = app.emit("chrome-use-host-installed", manifest);
    Ok(())
}

fn write_host_launcher(app_data_dir: &Path, exe: &Path) -> CmdResult<PathBuf> {
    let dir = app_data_dir.join("chrome-use");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let path = dir.join("cetus-chrome-use-host.cmd");
        let body = format!(
            "@echo off\r\n\"{}\" {} {} \"{}\"\r\n",
            exe.display(),
            HOST_ARG,
            STATE_DIR_ARG,
            app_data_dir.display()
        );
        fs::write(&path, body).map_err(|e| e.to_string())?;
        Ok(path)
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("cetus-chrome-use-host.sh");
        let body = format!(
            "#!/bin/sh\nexec \"{}\" {} {} \"{}\"\n",
            exe.display(),
            HOST_ARG,
            STATE_DIR_ARG,
            app_data_dir.display()
        );
        fs::write(&path, body).map_err(|e| e.to_string())?;
        let mut perms = fs::metadata(&path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).map_err(|e| e.to_string())?;
        Ok(path)
    }
}

fn run_native_host(state_dir: &Path) -> std::io::Result<()> {
    if let Some(parent) = messages_path(state_dir).parent() {
        fs::create_dir_all(parent)?;
    }
    let mut command_offset = fs::metadata(commands_path(state_dir))
        .map(|m| m.len())
        .unwrap_or(0);
    let done = Arc::new(AtomicBool::new(false));
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let reader_state_dir = state_dir.to_path_buf();
    let reader_done = done.clone();
    let reader_stdout = stdout.clone();
    let reader = thread::spawn(move || {
        let mut stdin = std::io::stdin();
        loop {
            match read_native_message_from(&mut stdin) {
                Ok(Some(message)) => {
                    let envelope = json!({
                        "receivedAt": now_ms(),
                        "message": message
                    });
                    if append_message(&reader_state_dir, &envelope).is_ok() {
                        let _ = write_native_message_locked(
                            &reader_stdout,
                            &json!({
                                "ok": true,
                                "receivedAt": envelope["receivedAt"]
                            }),
                        );
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = write_native_message_locked(
                        &reader_stdout,
                        &json!({
                            "ok": false,
                            "error": e.to_string()
                        }),
                    );
                    break;
                }
            }
        }
        reader_done.store(true, Ordering::SeqCst);
    });

    while !done.load(Ordering::SeqCst) {
        for command in read_new_commands(state_dir, &mut command_offset)? {
            write_native_message_locked(&stdout, &command)?;
        }
        thread::sleep(Duration::from_millis(250));
    }
    let _ = reader.join();
    Ok(())
}

fn read_native_message_from(input: &mut impl Read) -> std::io::Result<Option<Value>> {
    let mut len = [0u8; 4];
    match input.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len) as usize;
    if len > 2 * 1024 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "native message exceeds 2MB",
        ));
    }
    let mut buf = vec![0u8; len];
    input.read_exact(&mut buf)?;
    serde_json::from_slice(&buf)
        .map(Some)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

fn write_native_message(value: &Value) -> std::io::Result<()> {
    let message = native_message_bytes(value)?;
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(&message)?;
    stdout.flush()
}

fn write_native_message_locked(
    stdout: &Arc<Mutex<std::io::Stdout>>,
    value: &Value,
) -> std::io::Result<()> {
    let message = native_message_bytes(value)?;
    let mut out = stdout.lock().unwrap();
    out.write_all(&message)?;
    out.flush()
}

fn native_message_bytes(value: &Value) -> std::io::Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value)?;
    let mut message = Vec::with_capacity(4 + bytes.len());
    message.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    message.extend_from_slice(&bytes);
    Ok(message)
}

fn read_new_commands(state_dir: &Path, offset: &mut u64) -> std::io::Result<Vec<Value>> {
    let path = commands_path(state_dir);
    let mut file = match OpenOptions::new().read(true).open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let len = file.metadata()?.len();
    if len < *offset {
        *offset = 0;
    }
    file.seek(SeekFrom::Start(*offset))?;
    let mut raw = String::new();
    file.read_to_string(&mut raw)?;
    *offset = len;
    Ok(raw
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect())
}

fn append_message(state_dir: &Path, value: &Value) -> std::io::Result<()> {
    let path = messages_path(state_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    serde_json::to_writer(&mut file, value)?;
    file.write_all(b"\n")
}

fn read_last_message(app_data_dir: &Path) -> Option<Value> {
    let raw = fs::read_to_string(messages_path(app_data_dir)).ok()?;
    raw.lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
}

fn native_host_manifest_path() -> CmdResult<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "HOME is not set".to_string())?;
        return Ok(home
            .join("Library/Application Support/Google/Chrome/NativeMessagingHosts")
            .join(format!("{HOST_NAME}.json")));
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| "APPDATA is not set".to_string())?;
        return Ok(appdata
            .join("Google/Chrome/NativeMessagingHosts")
            .join(format!("{HOST_NAME}.json")));
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "HOME is not set".to_string())?;
        Ok(home
            .join(".config/google-chrome/NativeMessagingHosts")
            .join(format!("{HOST_NAME}.json")))
    }
}

fn extension_origin() -> String {
    format!("chrome-extension://{EXTENSION_ID}/")
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_origin_uses_stable_id() {
        assert_eq!(
            extension_origin(),
            "chrome-extension://bellidpjmeaomkdjbhkcaokmeflanpmc/"
        );
    }

    #[test]
    fn reads_last_message_from_jsonl() {
        let dir = std::env::temp_dir().join(format!("cetus-chrome-use-test-{}", now_ms()));
        fs::create_dir_all(dir.join("chrome-use")).unwrap();
        append_message(&dir, &json!({"message":{"type":"one"}})).unwrap();
        append_message(&dir, &json!({"message":{"type":"two"}})).unwrap();

        let last = read_last_message(&dir).unwrap();
        assert_eq!(last["message"]["type"], "two");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_new_commands_from_offset() {
        let dir = std::env::temp_dir().join(format!("cetus-chrome-use-cmd-test-{}", now_ms()));
        fs::create_dir_all(dir.join("chrome-use")).unwrap();
        fs::write(
            commands_path(&dir),
            "{\"type\":\"command\",\"id\":\"old\",\"command\":\"list_tabs\"}\n",
        )
        .unwrap();
        let mut offset = fs::metadata(commands_path(&dir)).unwrap().len();
        let first = read_new_commands(&dir, &mut offset).unwrap();
        assert!(first.is_empty());

        let mut file = OpenOptions::new()
            .append(true)
            .open(commands_path(&dir))
            .unwrap();
        file.write_all(
            b"{\"type\":\"command\",\"id\":\"new\",\"command\":\"active_tab_snapshot\"}\n",
        )
        .unwrap();
        let second = read_new_commands(&dir, &mut offset).unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0]["id"], "new");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn encodes_native_message_with_little_endian_length() {
        let value = json!({"type":"self_test"});
        let message = native_message_bytes(&value).unwrap();
        let len = u32::from_le_bytes(message[0..4].try_into().unwrap()) as usize;
        assert_eq!(len, message.len() - 4);
        assert_eq!(
            serde_json::from_slice::<Value>(&message[4..]).unwrap(),
            value
        );
    }
}
