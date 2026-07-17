//! Native thumbnails for local Artifact files.
//!
//! On macOS this uses Quick Look Thumbnailing, the same system facility Finder
//! uses for previews. Generated PNGs are cached under app data and keyed by the
//! source path + size + modification time, so replacing a file invalidates its
//! cover without any database state.

use crate::AppState;
use std::path::{Path, PathBuf};
use tauri::State;

const THUMBNAIL_EDGE: u32 = 768;

#[tauri::command]
pub async fn get_artifact_thumbnail(
    path: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let source = PathBuf::from(path);
    let metadata = std::fs::metadata(&source).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("artifact path is not a regular file".into());
    }

    #[cfg(target_os = "macos")]
    {
        let cache_dir = state.app_data_dir.join("artifact-thumbnails");
        return tokio::task::spawn_blocking(move || {
            macos::generate(&source, &metadata, &cache_dir, THUMBNAIL_EDGE)
        })
        .await
        .map_err(|e| format!("thumbnail task failed: {e}"))?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, source, metadata);
        Ok(None)
    }
}

fn cache_path(source: &Path, metadata: &std::fs::Metadata, cache_dir: &Path, edge: u32) -> PathBuf {
    use std::hash::{Hash, Hasher};
    use std::time::UNIX_EPOCH;

    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    source.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified.hash(&mut hasher);
    edge.hash(&mut hasher);
    cache_dir.join(format!("{:016x}.png", hasher.finish()))
}

#[cfg(target_os = "macos")]
mod macos {
    use super::cache_path;
    use block2::RcBlock;
    use objc2::AnyThread;
    use objc2_core_foundation::CGSize;
    use objc2_foundation::{NSError, NSString, NSURL};
    use objc2_quick_look_thumbnailing::{
        QLThumbnailGenerationRequest, QLThumbnailGenerationRequestRepresentationTypes,
        QLThumbnailGenerator,
    };
    use objc2_uniform_type_identifiers::UTTypePNG;
    use std::path::Path;
    use std::time::Duration;

    pub(super) fn generate(
        source: &Path,
        metadata: &std::fs::Metadata,
        cache_dir: &Path,
        edge: u32,
    ) -> Result<Option<String>, String> {
        std::fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;
        let output = cache_path(source, metadata, cache_dir, edge);
        if output.metadata().is_ok_and(|m| m.len() > 0) {
            return Ok(Some(output.to_string_lossy().into_owned()));
        }

        let source_string = NSString::from_str(&source.to_string_lossy());
        let output_string = NSString::from_str(&output.to_string_lossy());
        let source_url = NSURL::fileURLWithPath(&source_string);
        let output_url = NSURL::fileURLWithPath(&output_string);
        let request = unsafe {
            QLThumbnailGenerationRequest::initWithFileAtURL_size_scale_representationTypes(
                QLThumbnailGenerationRequest::alloc(),
                &source_url,
                CGSize::new(edge as f64, edge as f64),
                1.0,
                QLThumbnailGenerationRequestRepresentationTypes::Thumbnail,
            )
        };
        unsafe { request.setIconMode(false) };

        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let completion = RcBlock::new(move |error: *mut NSError| {
            let _ = sender.send(error.is_null());
        });
        let generator = unsafe { QLThumbnailGenerator::sharedGenerator() };
        unsafe {
            generator.saveBestRepresentationForRequest_toFileAtURL_asContentType_completionHandler(
                &request,
                &output_url,
                UTTypePNG,
                &completion,
            );
        }

        match receiver.recv_timeout(Duration::from_secs(15)) {
            Ok(true) if output.metadata().is_ok_and(|m| m.len() > 0) => {
                Ok(Some(output.to_string_lossy().into_owned()))
            }
            Ok(true) => Err("Quick Look returned without writing a thumbnail".into()),
            Ok(false) => {
                let _ = std::fs::remove_file(&output);
                Ok(None)
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                unsafe { generator.cancelRequest(&request) };
                let _ = std::fs::remove_file(&output);
                Err("Quick Look thumbnail generation timed out".into())
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                let _ = std::fs::remove_file(&output);
                Err("Quick Look thumbnail callback disconnected".into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::cache_path;
    use std::io::Write;

    #[test]
    fn cache_key_changes_when_source_changes() {
        let dir =
            std::env::temp_dir().join(format!("cetus-thumbnail-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("video.mp4");
        std::fs::write(&source, b"one").unwrap();
        let first = cache_path(&source, &source.metadata().unwrap(), &dir, 768);

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&source)
            .unwrap();
        file.write_all(b"two").unwrap();
        let second = cache_path(&source, &source.metadata().unwrap(), &dir, 768);
        assert_ne!(first, second);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn quick_look_generates_a_video_cover() {
        let Ok(ffmpeg) = std::process::Command::new("/usr/bin/which")
            .arg("ffmpeg")
            .output()
        else {
            return;
        };
        if !ffmpeg.status.success() {
            return;
        }
        let ffmpeg = String::from_utf8(ffmpeg.stdout).unwrap();
        let dir = std::env::temp_dir().join(format!(
            "cetus-thumbnail-video-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("cover-source.mp4");
        let status = std::process::Command::new(ffmpeg.trim())
            .args([
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=0x336699:s=320x180:d=1",
                "-pix_fmt",
                "yuv420p",
                "-y",
            ])
            .arg(&source)
            .status()
            .unwrap();
        assert!(status.success());

        let cover = super::macos::generate(
            &source,
            &source.metadata().unwrap(),
            &dir.join("cache"),
            256,
        )
        .unwrap()
        .expect("Quick Look should support MP4");
        let bytes = std::fs::read(cover).unwrap();
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
