//! Cetus plugin registry.
//!
//! A plugin is the packaging unit for agent-facing capability: manifest metadata,
//! optional pi extensions, optional MCP servers, optional skills, and optional
//! system-prompt guidance. Built-in plugins live in `src-tauri/cetus-plugins`
//! during development and in `<pi-install>/cetus-plugins` at runtime. User
//! plugins may be added under `<app_data>/plugins`; they are scanned with the
//! same manifest shape, but native capabilities are trusted only for built-ins.

use crate::agent;
use crate::store::Store;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub const CETUS_PLUGINS_DIR: &str = "cetus-plugins";
pub const CETUS_BUILTIN_PLUGINS_ENV: &str = "CETUS_BUILTIN_PLUGINS_DIR";
pub const CETUS_USER_PLUGINS_ENV: &str = "CETUS_USER_PLUGINS_DIR";

const MANIFEST_REL: &str = ".codex-plugin/plugin.json";
const SETTINGS_KEY: &str = "plugins";
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginManifest {
    #[serde(alias = "name")]
    id: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    activation: PluginActivation,
    #[serde(default)]
    interface: PluginInterface,
    #[serde(default)]
    system_prompt: Option<String>,
    #[serde(default)]
    extensions: Vec<String>,
    #[serde(default)]
    core_extension_overrides: Vec<String>,
    #[serde(default)]
    mcp_servers: Option<Value>,
    #[serde(default)]
    apps: Option<String>,
    #[serde(default)]
    skills: Option<String>,
    #[serde(default)]
    native_capabilities: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginActivation {
    /// Stable Cetus capability switch that enables this plugin.
    #[serde(default)]
    agent_control_surface: Option<String>,
    /// Future-compatible default for plugins without a Cetus capability switch.
    #[serde(default)]
    enabled_by_default: bool,
    #[serde(default = "default_available")]
    available: bool,
    #[serde(default)]
    unavailable_reason: Option<String>,
}

fn default_available() -> bool {
    true
}

impl Default for PluginActivation {
    fn default() -> Self {
        Self {
            agent_control_surface: None,
            enabled_by_default: false,
            available: true,
            unavailable_reason: None,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginInterface {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    short_description: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default)]
    risk_level: Option<String>,
}

#[derive(Debug, Clone)]
struct Plugin {
    manifest: PluginManifest,
    root: PathBuf,
    built_in: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    pub built_in: bool,
    pub enabled: bool,
    pub configurable: bool,
    pub available: bool,
    pub unavailable_reason: Option<String>,
    pub path: String,
    pub extensions: Vec<PathBuf>,
    pub mcp_servers: Vec<String>,
    pub apps: Vec<String>,
    pub native_capabilities: Vec<String>,
    pub interface_capabilities: Vec<String>,
    pub risk_level: Option<String>,
    pub agent_control_surface: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn list_plugins(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<PluginEntry>, String> {
    Ok(plugin_entries(
        Some(&state.pi_dir),
        Some(&state.app_data_dir),
        &state.store,
    ))
}

#[tauri::command]
pub async fn set_plugin_enabled(
    state: tauri::State<'_, crate::AppState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let plugins = load_plugins(Some(&state.pi_dir), Some(&state.app_data_dir));
    let plugin = plugins
        .iter()
        .find(|p| p.manifest.id == id)
        .ok_or_else(|| format!("plugin not found: {id}"))?;
    if !plugin.manifest.activation.available {
        return Err(plugin
            .manifest
            .activation
            .unavailable_reason
            .clone()
            .unwrap_or_else(|| "plugin is not available".into()));
    }
    if let Some(surface) = plugin.manifest.activation.agent_control_surface.as_deref() {
        let mut settings = agent::load_settings(&state.store);
        match surface {
            "browser" => settings.browser = enabled,
            "computer" => settings.computer = enabled,
            _ => {
                return Err(format!(
                    "plugin {id} uses unknown control surface {surface}"
                ))
            }
        }
        agent::save_settings(&state.store, &settings).map_err(|e| e.to_string())?;
        agent::export_enabled(&state.store);
        crate::mcp::export_config(&state.app_data_dir, &state.store);
        if settings.browser {
            tauri::async_runtime::spawn(async {
                if let Err(e) = agent::ensure_chrome_running().await {
                    tracing::warn!("chrome-devtools: warm-up launch failed: {e}");
                }
            });
        }
        return Ok(());
    }
    let mut settings = load_settings(&state.store);
    settings.set_enabled(&id, enabled);
    save_settings(&state.store, &settings)?;
    crate::mcp::export_config(&state.app_data_dir, &state.store);
    Ok(())
}

#[tauri::command]
pub async fn import_plugin(
    state: tauri::State<'_, crate::AppState>,
    path: String,
) -> Result<PluginEntry, String> {
    let src = PathBuf::from(path);
    let plugin = read_manifest(src.clone(), false).ok_or_else(|| {
        format!(
            "plugin folder must contain {}",
            src.join(MANIFEST_REL).display()
        )
    })?;
    if plugin.manifest.activation.agent_control_surface.is_some() {
        return Err("third-party plugins cannot claim built-in computer/browser surfaces".into());
    }
    if !plugin.manifest.native_capabilities.is_empty() {
        return Err("third-party plugins cannot request native capabilities yet".into());
    }
    let dst_root = user_plugins_dir(&state.app_data_dir);
    std::fs::create_dir_all(&dst_root).map_err(|e| e.to_string())?;
    let dst = dst_root.join(safe_dir_name(&plugin.manifest.id));
    if dst.exists() {
        std::fs::remove_dir_all(&dst).map_err(|e| e.to_string())?;
    }
    copy_dir(&src, &dst).map_err(|e| e.to_string())?;
    let installed = read_manifest(dst, false).ok_or("installed plugin manifest is missing")?;
    let mut settings = load_settings(&state.store);
    settings.set_enabled(
        &installed.manifest.id,
        installed.manifest.activation.enabled_by_default,
    );
    save_settings(&state.store, &settings)?;
    crate::mcp::export_config(&state.app_data_dir, &state.store);
    Ok(plugin_entry(installed, &state.store))
}

#[tauri::command]
pub async fn reveal_plugin(
    state: tauri::State<'_, crate::AppState>,
    id: String,
) -> Result<(), String> {
    let plugin = load_plugins(Some(&state.pi_dir), Some(&state.app_data_dir))
        .into_iter()
        .find(|p| p.manifest.id == id)
        .ok_or_else(|| format!("plugin not found: {id}"))?;
    reveal_path(state.handle(), &plugin.root)
}

#[tauri::command]
pub async fn delete_plugin(
    state: tauri::State<'_, crate::AppState>,
    id: String,
) -> Result<(), String> {
    let plugin = load_plugins(Some(&state.pi_dir), Some(&state.app_data_dir))
        .into_iter()
        .find(|p| p.manifest.id == id)
        .ok_or_else(|| format!("plugin not found: {id}"))?;
    if plugin.built_in {
        return Err("built-in plugins cannot be deleted".into());
    }
    let user_root = user_plugins_dir(&state.app_data_dir);
    if !plugin.root.starts_with(&user_root) {
        return Err("refusing to delete a plugin outside the user plugins folder".into());
    }
    std::fs::remove_dir_all(&plugin.root).map_err(|e| e.to_string())?;
    let mut settings = load_settings(&state.store);
    settings.enabled.remove(&id);
    save_settings(&state.store, &settings)?;
    crate::mcp::export_config(&state.app_data_dir, &state.store);
    Ok(())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginSettings {
    #[serde(default)]
    enabled: BTreeMap<String, bool>,
}

impl PluginSettings {
    fn set_enabled(&mut self, id: &str, enabled: bool) {
        self.enabled.insert(id.to_string(), enabled);
    }
}

fn load_settings(store: &Store) -> PluginSettings {
    store
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(store: &Store, settings: &PluginSettings) -> Result<(), String> {
    store
        .set_setting(
            SETTINGS_KEY,
            &serde_json::to_string(settings).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
}

fn read_manifest(root: PathBuf, built_in: bool) -> Option<Plugin> {
    let manifest_path = root.join(MANIFEST_REL);
    let raw = std::fs::read_to_string(&manifest_path).ok()?;
    let mut manifest: PluginManifest = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!("plugin: failed to parse {}: {e}", manifest_path.display());
            return None;
        }
    };
    if manifest.id.trim().is_empty() {
        tracing::warn!("plugin: {} has an empty id", manifest_path.display());
        return None;
    }
    if manifest.display_name.trim().is_empty() {
        manifest.display_name = manifest
            .interface
            .display_name
            .clone()
            .unwrap_or_else(|| manifest.id.clone());
    }
    if manifest.description.trim().is_empty() {
        manifest.description = manifest
            .interface
            .short_description
            .clone()
            .unwrap_or_default();
    }
    Some(Plugin {
        manifest,
        root,
        built_in,
    })
}

fn scan_dir(dir: &Path, built_in: bool) -> Vec<Plugin> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut plugins = Vec::new();
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_dir() {
            continue;
        }
        if let Some(plugin) = read_manifest(entry.path(), built_in) {
            plugins.push(plugin);
        }
    }
    plugins.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
    plugins
}

pub fn dev_plugins_src() -> Option<PathBuf> {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join(CETUS_PLUGINS_DIR);
    p.is_dir().then_some(p)
}

pub fn runtime_plugins_dir(pi_dir: &Path) -> PathBuf {
    pi_dir.join(CETUS_PLUGINS_DIR)
}

pub fn user_plugins_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("plugins")
}

fn load_plugins(pi_dir: Option<&Path>, app_data_dir: Option<&Path>) -> Vec<Plugin> {
    fn add_built_in_dir(plugins: &mut Vec<Plugin>, seen: &mut BTreeSet<String>, dir: PathBuf) {
        for plugin in scan_dir(&dir, true) {
            if seen.insert(plugin.manifest.id.clone()) {
                plugins.push(plugin);
            }
        }
    }

    let mut plugins = Vec::new();
    let mut built_in_ids = BTreeSet::new();

    if let Some(env_dir) = std::env::var_os(CETUS_BUILTIN_PLUGINS_ENV).map(PathBuf::from) {
        add_built_in_dir(&mut plugins, &mut built_in_ids, env_dir);
        if plugins.is_empty() {
            if let Some(dev_dir) = dev_plugins_src() {
                add_built_in_dir(&mut plugins, &mut built_in_ids, dev_dir);
            }
        }
    } else {
        if let Some(pi_dir) = pi_dir {
            add_built_in_dir(&mut plugins, &mut built_in_ids, runtime_plugins_dir(pi_dir));
        }
        if let Some(dev_dir) = dev_plugins_src() {
            add_built_in_dir(&mut plugins, &mut built_in_ids, dev_dir);
        }
        if plugins.is_empty() {
            add_built_in_dir(
                &mut plugins,
                &mut built_in_ids,
                PathBuf::from(CETUS_PLUGINS_DIR),
            );
        }
    }

    let user_dir = app_data_dir
        .map(user_plugins_dir)
        .or_else(|| std::env::var_os(CETUS_USER_PLUGINS_ENV).map(PathBuf::from));
    if let Some(user_dir) = user_dir {
        plugins.extend(scan_dir(&user_dir, false));
    }
    plugins
}

fn plugin_enabled(plugin: &Plugin, store: &Store) -> bool {
    if !plugin.manifest.activation.available {
        return false;
    }
    match plugin.manifest.activation.agent_control_surface.as_deref() {
        Some("browser") => agent::load_settings(store).browser,
        Some("computer") => agent::load_settings(store).computer,
        Some(other) => {
            tracing::warn!(
                "plugin: {} has unknown agentControlSurface {:?}; disabled",
                plugin.manifest.id,
                other
            );
            false
        }
        None => load_settings(store)
            .enabled
            .get(&plugin.manifest.id)
            .copied()
            .unwrap_or(plugin.manifest.activation.enabled_by_default),
    }
}

pub fn plugin_entries(
    pi_dir: Option<&Path>,
    app_data_dir: Option<&Path>,
    store: &Store,
) -> Vec<PluginEntry> {
    load_plugins(pi_dir, app_data_dir)
        .into_iter()
        .map(|p| plugin_entry(p, store))
        .collect()
}

fn plugin_entry(p: Plugin, store: &Store) -> PluginEntry {
    let enabled = plugin_enabled(&p, store);
    let configurable = p.manifest.activation.available;
    let mcp_servers = plugin_mcp_servers(&p);
    let apps = p
        .manifest
        .apps
        .as_deref()
        .map(|rel| vec![p.root.join(rel).to_string_lossy().into_owned()])
        .unwrap_or_default();
    PluginEntry {
        id: p.manifest.id,
        display_name: p.manifest.display_name,
        version: p.manifest.version,
        description: p.manifest.description,
        built_in: p.built_in,
        enabled,
        configurable,
        available: p.manifest.activation.available,
        unavailable_reason: p.manifest.activation.unavailable_reason,
        path: p.root.to_string_lossy().into_owned(),
        extensions: p
            .manifest
            .extensions
            .iter()
            .map(|rel| p.root.join(rel))
            .collect(),
        mcp_servers: mcp_servers.keys().cloned().collect(),
        apps,
        native_capabilities: if p.built_in {
            p.manifest.native_capabilities
        } else {
            Vec::new()
        },
        interface_capabilities: p.manifest.interface.capabilities,
        risk_level: p.manifest.interface.risk_level,
        agent_control_surface: p.manifest.activation.agent_control_surface,
        error: None,
    }
}

pub fn plugin_owned_extension_names(
    pi_dir: Option<&Path>,
    app_data_dir: Option<&Path>,
) -> BTreeSet<String> {
    load_plugins(pi_dir, app_data_dir)
        .into_iter()
        .flat_map(|p| {
            let overrides = if p.built_in {
                p.manifest.core_extension_overrides
            } else {
                Vec::new()
            };
            p.manifest.extensions.into_iter().chain(overrides)
        })
        .filter_map(|rel| {
            Path::new(&rel)
                .file_name()
                .and_then(|s| s.to_str())
                .map(str::to_owned)
        })
        .collect()
}

pub fn enabled_extension_paths(pi_dir: &Path, store: &Store) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = load_plugins(Some(pi_dir), None)
        .into_iter()
        .filter(|p| plugin_enabled(p, store))
        .flat_map(|p| {
            p.manifest
                .extensions
                .into_iter()
                .map(move |rel| p.root.join(rel))
        })
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("ts"))
        .collect();
    paths.sort();
    paths
}

pub fn enabled_mcp_servers(store: &Store) -> BTreeMap<String, Value> {
    let mut servers = BTreeMap::new();
    for plugin in load_plugins(None, None)
        .into_iter()
        .filter(|p| plugin_enabled(p, store))
    {
        for (name, spec) in plugin_mcp_servers(&plugin) {
            servers.entry(name).or_insert(spec);
        }
    }
    servers
}

fn plugin_mcp_servers(plugin: &Plugin) -> BTreeMap<String, Value> {
    let Some(raw) = plugin.manifest.mcp_servers.as_ref() else {
        return BTreeMap::new();
    };
    let doc = match raw {
        Value::String(rel) => {
            let path = plugin.root.join(rel);
            match std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            {
                Some(v) => v,
                None => {
                    tracing::warn!("plugin: failed to read MCP config {}", path.display());
                    return BTreeMap::new();
                }
            }
        }
        other => other.clone(),
    };
    let servers_value = doc.get("mcpServers").unwrap_or(&doc);
    let Some(obj) = servers_value.as_object() else {
        tracing::warn!(
            "plugin: {} mcpServers must be an object or a path to a {{mcpServers}} document",
            plugin.manifest.id
        );
        return BTreeMap::new();
    };
    obj.iter()
        .map(|(name, spec)| (name.clone(), spec.clone()))
        .collect()
}

pub fn extra_system_prompt(store: &Store) -> Option<String> {
    let mut parts = Vec::new();
    for plugin in load_plugins(None, None)
        .into_iter()
        .filter(|p| plugin_enabled(p, store))
    {
        let Some(rel) = plugin.manifest.system_prompt.as_deref() else {
            continue;
        };
        let path = plugin.root.join(rel);
        match std::fs::read_to_string(&path) {
            Ok(s) if !s.trim().is_empty() => parts.push(s),
            Ok(_) => {}
            Err(e) => tracing::warn!("plugin: failed to read {}: {e}", path.display()),
        }
    }
    (!parts.is_empty()).then(|| format!("\n\n{}", parts.join("\n\n")))
}

pub fn plugin_freeze_skills(app_data_dir: &Path, dst_skills_dir: &Path, store: &Store) {
    for plugin in load_plugins(None, Some(app_data_dir))
        .into_iter()
        .filter(|p| plugin_enabled(p, store))
    {
        let Some(rel) = plugin.manifest.skills.as_deref() else {
            continue;
        };
        let src = plugin.root.join(rel);
        if !src.is_dir() {
            continue;
        }
        let prefix = safe_dir_name(&plugin.manifest.id);
        if src.join("SKILL.md").is_file() {
            let dst = dst_skills_dir.join(prefix);
            if let Err(e) = copy_dir(&src, &dst) {
                tracing::warn!(
                    "plugin: failed to materialize skill from {}: {e}",
                    src.display()
                );
            }
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&src) else {
            continue;
        };
        for entry in entries.flatten() {
            let child = entry.path();
            if !child.join("SKILL.md").is_file() {
                continue;
            }
            let child_name = entry.file_name().to_string_lossy().to_string();
            let dst = dst_skills_dir.join(format!("{prefix}-{}", safe_dir_name(&child_name)));
            if let Err(e) = copy_dir(&child, &dst) {
                tracing::warn!(
                    "plugin: failed to materialize skill from {}: {e}",
                    child.display()
                );
            }
        }
    }
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir(&from, &to)?;
        } else if ft.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn safe_dir_name(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for ch in id.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches(['.', '-']);
    if trimmed.is_empty() {
        "plugin".to_string()
    } else {
        trimmed.to_string()
    }
}

fn reveal_path(_app: &AppHandle, path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err("plugin folder is missing".into());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = _app;
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_plugin_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("cetus-plugin-test-{name}-{nonce}"));
        std::fs::create_dir_all(dir.join(".codex-plugin")).unwrap();
        dir
    }

    #[test]
    fn reads_codex_style_name_and_interface_display_name() {
        let dir = temp_plugin_dir("manifest");
        std::fs::write(
            dir.join(MANIFEST_REL),
            r#"{
              "name": "example.plugin",
              "interface": {
                "displayName": "Example Plugin",
                "shortDescription": "Example description",
                "capabilities": ["Read"]
              }
            }"#,
        )
        .unwrap();

        let plugin = read_manifest(dir.clone(), false).unwrap();
        assert_eq!(plugin.manifest.id, "example.plugin");
        assert_eq!(plugin.manifest.display_name, "Example Plugin");
        assert_eq!(plugin.manifest.description, "Example description");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn resolves_inline_mcp_servers() {
        let plugin = Plugin {
            root: PathBuf::from("/tmp/unused"),
            built_in: false,
            manifest: PluginManifest {
                id: "inline".into(),
                display_name: "Inline".into(),
                version: String::new(),
                description: String::new(),
                activation: PluginActivation::default(),
                interface: PluginInterface::default(),
                system_prompt: None,
                extensions: Vec::new(),
                core_extension_overrides: Vec::new(),
                mcp_servers: Some(json!({
                    "demo": { "command": "node", "args": ["server.js"] }
                })),
                apps: None,
                skills: None,
                native_capabilities: Vec::new(),
            },
        };

        let servers = plugin_mcp_servers(&plugin);
        assert!(servers.contains_key("demo"));
    }

    #[test]
    fn resolves_mcp_servers_from_path() {
        let dir = temp_plugin_dir("mcp");
        std::fs::write(
            dir.join(".mcp.json"),
            r#"{"mcpServers":{"demo":{"command":"node","args":["server.js"]}}}"#,
        )
        .unwrap();
        let plugin = Plugin {
            root: dir.clone(),
            built_in: false,
            manifest: PluginManifest {
                id: "path".into(),
                display_name: "Path".into(),
                version: String::new(),
                description: String::new(),
                activation: PluginActivation::default(),
                interface: PluginInterface::default(),
                system_prompt: None,
                extensions: Vec::new(),
                core_extension_overrides: Vec::new(),
                mcp_servers: Some(Value::String(".mcp.json".into())),
                apps: None,
                skills: None,
                native_capabilities: Vec::new(),
            },
        };

        let servers = plugin_mcp_servers(&plugin);
        assert!(servers.contains_key("demo"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn safe_dir_name_removes_path_separators() {
        assert_eq!(safe_dir_name("bad/plugin:name"), "bad-plugin-name");
    }

    #[test]
    fn bundled_computer_plugin_exposes_visual_observe_option() {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("cetus-plugins/computer-use/.codex-plugin/plugin.json");
        let plugin = read_manifest(
            manifest.parent().unwrap().parent().unwrap().to_path_buf(),
            true,
        )
        .unwrap();
        assert_eq!(plugin.manifest.id, "cetus.computer-use");

        let extension = plugin.root.join("extensions/computer-use.ts");
        let source = std::fs::read_to_string(extension).unwrap();
        assert!(source.contains("includeScreenshot"));
        assert!(source.contains("type: \"image\""));
    }

    #[test]
    fn bundled_browser_plugin_exposes_visible_browser_tool() {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("cetus-plugins/browser-use/.codex-plugin/plugin.json");
        let plugin = read_manifest(
            manifest.parent().unwrap().parent().unwrap().to_path_buf(),
            true,
        )
        .unwrap();
        assert_eq!(plugin.manifest.id, "cetus.browser-use");
        assert_eq!(
            plugin.manifest.extensions,
            vec!["extensions/browser-visible.ts"]
        );
        assert_eq!(
            plugin.manifest.core_extension_overrides,
            vec!["browser-use.ts"]
        );

        let extension =
            std::fs::read_to_string(plugin.root.join("extensions/browser-visible.ts")).unwrap();
        assert!(extension.contains("browser_open_visible"));
        assert!(extension.contains("__cetus_browser_request__"));
    }

    #[test]
    fn bundled_chrome_plugin_carries_extension_scaffold() {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("cetus-plugins/chrome-use/.codex-plugin/plugin.json");
        let plugin = read_manifest(
            manifest.parent().unwrap().parent().unwrap().to_path_buf(),
            true,
        )
        .unwrap();

        assert_eq!(plugin.manifest.id, "cetus.chrome-use");
        assert_eq!(plugin.manifest.apps.as_deref(), Some(".app.json"));
        assert_eq!(plugin.manifest.extensions, vec!["extensions/chrome-use.ts"]);

        let app_json = std::fs::read_to_string(plugin.root.join(".app.json")).unwrap();
        assert!(app_json.contains("\"extensionPath\": \"extension\""));
        assert!(app_json.contains("\"extensionId\": \"bellidpjmeaomkdjbhkcaokmeflanpmc\""));
        assert!(app_json.contains("\"nativeHostName\": \"com.cetus.chrome_use\""));

        let extension_manifest =
            std::fs::read_to_string(plugin.root.join("extension/manifest.json")).unwrap();
        assert!(extension_manifest.contains("\"manifest_version\": 3"));
        assert!(extension_manifest.contains("\"key\""));
        assert!(extension_manifest.contains("\"nativeMessaging\""));

        let background =
            std::fs::read_to_string(plugin.root.join("extension/background.js")).unwrap();
        assert!(background.contains("page_snapshot"));
        assert!(background.contains("select_tab"));
        assert!(background.contains("navigate"));
        assert!(background.contains("click"));
        assert!(background.contains("fill"));
        assert!(background.contains("consequential"));
        assert!(background.contains("allowConsequential"));
        assert!(background.contains("Refusing to fill"));

        let pi_extension =
            std::fs::read_to_string(plugin.root.join("extensions/chrome-use.ts")).unwrap();
        assert!(pi_extension.contains("chrome_page_snapshot"));
        assert!(pi_extension.contains("chrome_click"));
        assert!(pi_extension.contains("chrome_fill"));
        assert!(pi_extension.contains("chrome_active_tab_snapshot"));
        assert!(pi_extension.contains("CETUS_CHROME_USE_MESSAGES"));
        assert!(pi_extension.contains("CETUS_CHROME_USE_COMMANDS"));
        assert!(pi_extension.contains("command_result"));
        assert!(pi_extension.contains("chrome_select_tab"));
        assert!(pi_extension.contains("chrome_navigate"));
        assert!(pi_extension.contains("Confirm Chrome navigation"));
        assert!(pi_extension.contains("Confirm Chrome click"));
        assert!(pi_extension.contains("Confirm Chrome fill"));
        assert!(pi_extension.contains("allowConsequential"));
    }

    #[test]
    fn dev_builtin_plugins_fallback_when_runtime_dir_is_missing() {
        let pi_dir = temp_plugin_dir("empty-pi");
        std::fs::remove_dir_all(pi_dir.join(".codex-plugin")).unwrap();

        let plugins = load_plugins(Some(&pi_dir), None);

        assert!(plugins.iter().any(|p| p.manifest.id == "cetus.browser-use"));
        assert!(plugins
            .iter()
            .any(|p| p.manifest.id == "cetus.computer-use"));
        let _ = std::fs::remove_dir_all(pi_dir);
    }

    #[test]
    fn dev_builtin_plugins_fill_empty_runtime_plugins_dir() {
        let pi_dir = temp_plugin_dir("empty-runtime-plugins");
        std::fs::remove_dir_all(pi_dir.join(".codex-plugin")).unwrap();
        std::fs::create_dir_all(runtime_plugins_dir(&pi_dir)).unwrap();

        let plugins = load_plugins(Some(&pi_dir), None);

        assert!(plugins.iter().any(|p| p.manifest.id == "cetus.browser-use"));
        assert!(plugins
            .iter()
            .any(|p| p.manifest.id == "cetus.computer-use"));
        let _ = std::fs::remove_dir_all(pi_dir);
    }
}
