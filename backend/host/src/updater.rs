//! Self-update from the GitHub release feed: `latest.json` lists a signed
//! `Cetus.app.tar.gz` per platform, signed with the release minisign key
//! (CI secret `TAURI_SIGNING_PRIVATE_KEY`). The feed keeps the Tauri updater
//! format so the last Tauri builds (≤ 0.4.18) update straight into the
//! Electron app, and the Electron app keeps updating from the same feed.
//!
//! `install` swaps the whole `.app` bundle in place; callers only do that on
//! the way out (quit / relaunch), never under a running process's feet.

use std::path::{Path, PathBuf};

use base64::Engine;
use futures_util::StreamExt;
use serde::Deserialize;

use crate::{AppHandle, Error, Result};

const ENDPOINT: &str = "https://github.com/drewnekota/cetus/releases/latest/download/latest.json";
/// base64 of the minisign public key file (same key the Tauri builds used).
const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEM2RDUzQUNCNDJFQTk4MzgKUldRNG1PcEN5enJWeGlNdHFOTWRFMitkckRvS2cvL3RCQUNEMnBuZmxpbi9FSURPSHk3dWVqdDAK";

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const PLATFORM: &str = "darwin-aarch64";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const PLATFORM: &str = "darwin-x86_64";
#[cfg(not(target_os = "macos"))]
const PLATFORM: &str = "linux-x86_64";

fn err(e: impl std::fmt::Display) -> Error {
    Error(e.to_string())
}

#[derive(Deserialize)]
struct Manifest {
    version: String,
    notes: Option<String>,
    platforms: std::collections::HashMap<String, PlatformEntry>,
}

#[derive(Deserialize)]
struct PlatformEntry {
    url: String,
    signature: String,
}

#[derive(Debug, Clone)]
pub struct Update {
    pub version: String,
    pub current_version: String,
    pub body: Option<String>,
    url: String,
    signature: String,
}

fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim().trim_start_matches('v');
    let core = v.split(['-', '+']).next()?;
    let mut it = core.split('.').map(|p| p.parse::<u64>().ok());
    Some((it.next()??, it.next()??, it.next().flatten().unwrap_or(0)))
}

fn http(current_version: &str) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(format!("cetus-updater/{current_version}"))
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(err)
}

fn verify(bytes: &[u8], signature_b64: &str) -> Result<()> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let pk_text = String::from_utf8(b64.decode(PUBKEY).map_err(err)?).map_err(err)?;
    let sig_text =
        String::from_utf8(b64.decode(signature_b64.trim()).map_err(err)?).map_err(err)?;
    let pk = minisign_verify::PublicKey::decode(&pk_text).map_err(err)?;
    let sig = minisign_verify::Signature::decode(&sig_text).map_err(err)?;
    pk.verify(bytes, &sig, true)
        .map_err(|e| Error(format!("update signature mismatch: {e}")))
}

/// `…/Cetus.app` of the running process.
fn current_bundle() -> Result<PathBuf> {
    let exe = std::env::current_exe().map_err(err)?;
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(Path::to_path_buf)
        .ok_or_else(|| Error(format!("not running from an app bundle: {}", exe.display())))
}

impl Update {
    pub async fn download<C: FnMut(usize, Option<u64>), F: FnOnce()>(
        &self,
        mut on_chunk: C,
        on_finish: F,
    ) -> Result<Vec<u8>> {
        let resp = http(&self.current_version)?
            .get(&self.url)
            .send()
            .await
            .map_err(err)?
            .error_for_status()
            .map_err(err)?;
        let total = resp.content_length();
        let mut bytes = Vec::with_capacity(total.unwrap_or(0) as usize);
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(err)?;
            on_chunk(chunk.len(), total);
            bytes.extend_from_slice(&chunk);
        }
        on_finish();
        verify(&bytes, &self.signature)?;
        Ok(bytes)
    }

    /// Swap the running app bundle for the downloaded one.
    pub fn install(&self, bytes: &[u8]) -> Result<()> {
        install_into(&current_bundle()?, bytes)
    }
}

/// Unpack the tarball next to `bundle` and swap it in.
fn install_into(bundle: &Path, bytes: &[u8]) -> Result<()> {
    let parent = bundle
        .parent()
        .ok_or_else(|| Error("app bundle has no parent directory".into()))?;
    let stage = parent.join(format!(".cetus-update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(&stage).map_err(err)?;
    let result = (|| {
        let gz = flate2::read::GzDecoder::new(bytes);
        let mut archive = tar::Archive::new(gz);
        archive.set_preserve_permissions(true);
        archive.unpack(&stage).map_err(err)?;
        let new_app = std::fs::read_dir(&stage)
            .map_err(err)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .find(|p| p.extension().is_some_and(|e| e == "app"))
            .ok_or_else(|| Error("update archive holds no .app".into()))?;
        let backup = stage.join("previous.app");
        std::fs::rename(bundle, &backup).map_err(err)?;
        if let Err(e) = std::fs::rename(&new_app, bundle) {
            let _ = std::fs::rename(&backup, bundle);
            return Err(err(e));
        }
        // Bump the bundle's mtime so LaunchServices re-reads Info.plist.
        let _ = std::process::Command::new("/usr/bin/touch")
            .arg(bundle)
            .status();
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&stage);
    result
}

pub struct Updater {
    current_version: String,
}

impl Updater {
    pub async fn check(&self) -> Result<Option<Update>> {
        let manifest: Manifest = http(&self.current_version)?
            .get(ENDPOINT)
            .send()
            .await
            .map_err(err)?
            .error_for_status()
            .map_err(err)?
            .json()
            .await
            .map_err(err)?;
        let newer = match (
            parse_version(&manifest.version),
            parse_version(&self.current_version),
        ) {
            (Some(remote), Some(local)) => remote > local,
            _ => false,
        };
        if !newer {
            return Ok(None);
        }
        let Some(entry) = manifest.platforms.get(PLATFORM) else {
            return Ok(None);
        };
        Ok(Some(Update {
            version: manifest.version.trim_start_matches('v').to_string(),
            current_version: self.current_version.clone(),
            body: manifest.notes,
            url: entry.url.clone(),
            signature: entry.signature.clone(),
        }))
    }
}

pub trait UpdaterExt {
    fn updater(&self) -> Result<Updater>;
}

impl UpdaterExt for AppHandle {
    fn updater(&self) -> Result<Updater> {
        use crate::Manager;
        Ok(Updater {
            current_version: self.package_info().version.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically() {
        assert!(parse_version("0.5.0") > parse_version("0.4.18"));
        assert!(parse_version("v0.4.10") > parse_version("0.4.9"));
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
    }

    /// Verifies a published package fetched by hand:
    /// `CETUS_UPDATE_SAMPLE=/path/dir` holding `latest.json` + `Cetus.app.tar.gz`.
    #[test]
    #[ignore]
    fn verifies_published_package() {
        let dir = PathBuf::from(std::env::var("CETUS_UPDATE_SAMPLE").unwrap());
        let manifest: Manifest =
            serde_json::from_slice(&std::fs::read(dir.join("latest.json")).unwrap()).unwrap();
        let sig = &manifest.platforms[PLATFORM].signature;
        let bytes = std::fs::read(dir.join("Cetus.app.tar.gz")).unwrap();
        verify(&bytes, sig).expect("published package verifies");
        assert!(verify(&bytes[1..], sig).is_err());
    }

    #[test]
    fn install_swaps_the_bundle() {
        let dir = std::env::temp_dir().join(format!("cetus-install-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let src = dir.join("src/Cetus.app/Contents");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("marker"), "new").unwrap();
        let installed = dir.join("Applications/Cetus.app");
        std::fs::create_dir_all(installed.join("Contents")).unwrap();
        std::fs::write(installed.join("Contents/marker"), "old").unwrap();

        let mut tarball = Vec::new();
        {
            let gz = flate2::write::GzEncoder::new(&mut tarball, flate2::Compression::fast());
            let mut b = tar::Builder::new(gz);
            b.append_dir_all("Cetus.app", dir.join("src/Cetus.app"))
                .unwrap();
            b.into_inner().unwrap().finish().unwrap();
        }
        install_into(&installed, &tarball).unwrap();
        assert_eq!(
            std::fs::read_to_string(installed.join("Contents/marker")).unwrap(),
            "new"
        );
        let leftovers: Vec<_> = std::fs::read_dir(dir.join("Applications"))
            .unwrap()
            .collect();
        assert_eq!(leftovers.len(), 1, "staging dir cleaned up");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_unsigned_bytes() {
        let bogus =
            base64::engine::general_purpose::STANDARD.encode("untrusted comment: x\nRWQ=\n");
        assert!(verify(b"hello", &bogus).is_err());
    }
}
