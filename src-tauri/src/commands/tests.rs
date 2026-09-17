use super::*;

#[test]
fn title_source_hides_attachment_protocol() {
    let prompt = "按照文件里的 SOP 分析机会\n\n<cetus-attachments>\n\
The user attached these files. Read these paths using available tools. Extract document text locally; render scanned pages to images or use OCR when needed:\n\
- guide.pdf → /tmp/guide.pdf\n</cetus-attachments>";
    assert_eq!(title_source(prompt), "按照文件里的 SOP 分析机会");
}

#[test]
fn title_source_uses_file_names_for_attachment_only_messages() {
    let prompt = "\n\n<cetus-attachments>\n\
The user attached these files. Read these paths using available tools. Extract document text locally; render scanned pages to images or use OCR when needed:\n\
- guide.pdf → /tmp/guide.pdf\n\
- data.csv → /tmp/data.csv\n</cetus-attachments>";
    assert_eq!(title_source(prompt), "guide.pdf、data.csv");
}

fn run_git(root: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git command failed: {args:?}");
}

#[test]
fn workspace_directory_reports_git_states_symlinks_and_deleted_files() {
    let root = std::env::temp_dir().join(format!("cetus-listing-{}", Uuid::new_v4()));
    std::fs::create_dir_all(root.join("cache")).unwrap();
    std::fs::create_dir_all(root.join("nested/cache")).unwrap();
    std::fs::write(root.join(".gitignore"), "cache/\nnested/cache/\n").unwrap();
    std::fs::write(root.join("nested/tracked.txt"), "tracked").unwrap();
    std::fs::write(root.join("nested/cache/ignored.txt"), "ignored").unwrap();
    std::fs::write(root.join("tracked.txt"), "initial").unwrap();
    std::fs::write(root.join("deleted.txt"), "delete me").unwrap();
    run_git(&root, &["init", "-q"]);
    run_git(&root, &["add", "."]);
    run_git(
        &root,
        &[
            "-c",
            "user.name=Cetus Test",
            "-c",
            "user.email=cetus@example.invalid",
            "commit",
            "-qm",
            "fixture",
        ],
    );
    std::fs::write(root.join("tracked.txt"), "changed").unwrap();
    std::fs::write(root.join("untracked.txt"), "new").unwrap();
    std::fs::remove_file(root.join("deleted.txt")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("tracked.txt", root.join("linked.txt")).unwrap();

    let listing = list_local_workspace_directory(&root, None, 100).unwrap();
    let entry = |name: &str| {
        listing
            .entries
            .iter()
            .find(|entry| entry.name == name)
            .unwrap()
    };
    assert_eq!(entry("cache").git_status.as_deref(), Some("ignored"));
    assert_eq!(entry("nested").git_status, None);
    assert!(!entry("nested").is_ignored);
    assert_eq!(entry("tracked.txt").git_status.as_deref(), Some("modified"));
    assert_eq!(
        entry("untracked.txt").git_status.as_deref(),
        Some("untracked")
    );
    assert_eq!(entry("deleted.txt").git_status.as_deref(), Some("deleted"));
    #[cfg(unix)]
    assert!(entry("linked.txt").is_symlink);
    assert!(!listing.truncated);

    let limited = list_local_workspace_directory(&root, None, 2).unwrap();
    assert!(limited.truncated);
    assert_eq!(
        limited.entries.len(),
        3,
        "deleted Git entries remain visible"
    );

    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn remote_paths_are_normalized_before_boundary_checks() {
    assert_eq!(
        normalize_remote_path("/srv/repo/./src/../README.md").unwrap(),
        "/srv/repo/README.md"
    );
    assert!(normalize_remote_path("relative/path").is_err());
}

#[test]
fn porcelain_codes_map_to_file_decorations() {
    assert_eq!(porcelain_status(b"!!"), "ignored");
    assert_eq!(porcelain_status(b"??"), "untracked");
    assert_eq!(porcelain_status(b"UU"), "conflict");
    assert_eq!(porcelain_status(b" D"), "deleted");
    assert_eq!(porcelain_status(b"R "), "renamed");
    assert_eq!(porcelain_status(b"A "), "added");
    assert_eq!(porcelain_status(b" M"), "modified");
}

#[tokio::test]
async fn workspace_text_preview_is_bounded_and_rejects_escaping_symlinks() {
    let root = std::env::temp_dir().join(format!("cetus-preview-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let large = root.join("large.txt");
    std::fs::write(&large, vec![b'x'; 1024 * 1024 + 128]).unwrap();

    let preview = read_workspace_text_file(
        root.to_string_lossy().to_string(),
        large.to_string_lossy().to_string(),
    )
    .await
    .unwrap();
    assert!(preview.truncated);
    assert_eq!(preview.text.len(), 1024 * 1024);
    assert_eq!(preview.total_bytes, 1024 * 1024 + 128);

    #[cfg(unix)]
    {
        let outside = root
            .parent()
            .unwrap()
            .join(format!("outside-{}.txt", Uuid::new_v4()));
        std::fs::write(&outside, "secret").unwrap();
        let link = root.join("outside.txt");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let result = read_workspace_text_file(
            root.to_string_lossy().to_string(),
            link.to_string_lossy().to_string(),
        )
        .await;
        assert!(result.unwrap_err().contains("outside the workspace"));
        std::fs::remove_file(outside).unwrap();
    }

    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn workspace_editor_reads_dotfiles_and_saves_without_clobbering_external_changes() {
    let root = std::env::temp_dir().join(format!("cetus-editor-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let workspace = root.to_string_lossy().to_string();
    for name in [
        ".env.local",
        ".gitignore",
        "LICENSE",
        "config.custom",
        "next.config.mjs",
    ] {
        let path = root.join(name);
        let path_string = path.to_string_lossy().to_string();
        let original = "# 配置\r\nVALUE=old\r\n";
        std::fs::write(&path, original).unwrap();
        let preview = read_workspace_text_file(workspace.clone(), path_string.clone())
            .await
            .unwrap();
        assert_eq!(preview.text, original);
        assert!(!preview.truncated);
        write_workspace_text_file(
            workspace.clone(),
            path_string.clone(),
            "VALUE=new\r\n".into(),
            preview.text,
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "VALUE=new\r\n");
        std::fs::write(&path, "external edit").unwrap();
        let result = write_workspace_text_file(
            workspace.clone(),
            path_string,
            "overwrite".into(),
            "VALUE=new\r\n".into(),
        )
        .await;
        assert!(result.unwrap_err().contains("changed on disk"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "external edit");
    }
    let binary = root.join("binary.custom");
    std::fs::write(&binary, b"abc\0def").unwrap();
    assert!(
        read_workspace_text_file(workspace.clone(), binary.to_string_lossy().into())
            .await
            .is_err()
    );
    assert!(write_workspace_text_file(
        workspace.clone(),
        binary.to_string_lossy().into(),
        "abc".into(),
        "abc\0def".into()
    )
    .await
    .is_err());
    assert_eq!(std::fs::read(&binary).unwrap(), b"abc\0def");
    let large = root.join("large");
    std::fs::write(&large, vec![b'x'; 1024 * 1024 + 1]).unwrap();
    assert!(write_workspace_text_file(
        workspace.clone(),
        large.to_string_lossy().into(),
        "short".into(),
        "x".repeat(1024 * 1024)
    )
    .await
    .is_err());
    assert_eq!(std::fs::metadata(&large).unwrap().len(), 1024 * 1024 + 1);
    #[cfg(unix)]
    {
        let outside = root.with_extension("outside");
        std::fs::write(&outside, "original").unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(write_workspace_text_file(
            workspace,
            link.to_string_lossy().into(),
            "overwrite".into(),
            "original".into()
        )
        .await
        .unwrap_err()
        .contains("outside the workspace"));
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "original");
        std::fs::remove_file(outside).unwrap();
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn workspace_text_detection_is_lossless_at_preview_boundary() {
    assert!(decode_workspace_text(&[0xff, 0xfe], false).is_err());
    assert!(decode_workspace_text(b"SQLite format 3\0", false).is_err());
    assert_eq!(
        decode_workspace_text(&[b'a', 0xe4, 0xb8], true).unwrap(),
        "a"
    );
    assert!(decode_workspace_text(&[b'a', 0xe4, 0xb8], false).is_err());
    assert_eq!(
        decode_workspace_text("\u{feff}你好\r\n".as_bytes(), false).unwrap(),
        "\u{feff}你好\r\n"
    );
}

#[tokio::test]
async fn workspace_create_and_rename_stay_inside_parent() {
    let root = std::env::temp_dir().join(format!("cetus-actions-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let created = create_workspace_entry(
        root.to_string_lossy().to_string(),
        root.to_string_lossy().to_string(),
        "note.md".to_string(),
        false,
    )
    .await
    .unwrap();
    assert!(Path::new(&created).is_file());
    let renamed = rename_workspace_entry(
        root.to_string_lossy().to_string(),
        created,
        "renamed.md".to_string(),
    )
    .await
    .unwrap();
    assert!(Path::new(&renamed).is_file());
    assert!(create_workspace_entry(
        root.to_string_lossy().to_string(),
        root.to_string_lossy().to_string(),
        "../escape".to_string(),
        false,
    )
    .await
    .is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn workspace_files_respect_git_ignores_and_keep_shallow_entries() {
    let root = std::env::temp_dir().join(format!("cetus-files-{}", Uuid::new_v4()));
    std::fs::create_dir_all(root.join(".git/info")).unwrap();
    std::fs::create_dir_all(root.join("cache/nested")).unwrap();
    std::fs::create_dir_all(root.join("excluded/nested")).unwrap();
    std::fs::create_dir_all(root.join("src/deep")).unwrap();
    std::fs::write(root.join(".gitignore"), "cache/\n").unwrap();
    std::fs::write(root.join(".git/info/exclude"), "/excluded/\n").unwrap();
    std::fs::write(root.join("cache/nested/runtime.bin"), "cache").unwrap();
    std::fs::write(root.join("excluded/nested/memory.md"), "generated").unwrap();
    std::fs::write(root.join("src/deep/lib.rs"), "pub fn example() {}").unwrap();
    std::fs::write(root.join("README.md"), "project").unwrap();

    let entries = collect_workspace_files(&root, 8, 10).unwrap();
    let by_path = entries
        .iter()
        .map(|entry| (entry.relative_path.as_str(), entry.is_ignored))
        .collect::<std::collections::HashMap<_, _>>();

    assert_eq!(by_path.get("cache"), Some(&true));
    assert_eq!(by_path.get("excluded"), Some(&true));
    assert_eq!(by_path.get("src"), Some(&false));
    assert_eq!(by_path.get("README.md"), Some(&false));
    assert!(!by_path.contains_key("cache/nested"));
    assert!(!by_path.contains_key("excluded/nested"));
    assert_eq!(by_path.get("src/deep/lib.rs"), Some(&false));

    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn browser_annotation_script_uses_per_window_token() {
    let token = "__CETUS_BROWSER_ANNOTATION__test-token__";
    let script = browser_annotation_script(token, &BrowserAnnotationLabels::default(), true);

    assert!(script.contains(&format!("var PREFIX = \"{token}\";")));
    assert!(!script.contains("__CETUS_BROWSER_ANNOTATION_TOKEN__"));
}

#[test]
fn browser_annotation_script_keeps_payload_shape() {
    let script = browser_annotation_script(
        "__CETUS_BROWSER_ANNOTATION__test-token__",
        &BrowserAnnotationLabels::default(),
        true,
    );

    assert!(script.contains("selector: selector"));
    assert!(script.contains("rect: {"));
    assert!(script.contains("drawHighlight(target)"));
    assert!(script.contains("element: describeElement(target)"));
    assert!(script.contains("text: clippedText(target)"));
    assert!(script.contains("document.title = PREFIX + JSON.stringify(pending)"));
}

#[test]
fn browser_annotation_script_selects_elements_not_points() {
    let script = browser_annotation_script(
        "__CETUS_BROWSER_ANNOTATION__test-token__",
        &BrowserAnnotationLabels::default(),
        true,
    );

    assert!(script.contains("document.addEventListener(\"mousemove\", onMove, true)"));
    assert!(script.contains("document.addEventListener(\"click\", onPick, true)"));
    assert!(script.contains("getBoundingClientRect()"));
    assert!(script.contains("selectorFor(target)"));
    assert!(script.contains("cetus-browser-annotation-highlight"));
    assert!(script.contains("cetus-browser-annotation-mode"));
    assert!(!script.contains("cetus-browser-annotation-layer"));
    assert!(!script.contains("pos.textContent = \"x \""));
    assert!(!script.contains("xPct:"));
    assert!(!script.contains("yPct:"));
}

#[test]
fn browser_annotation_script_does_not_capture_own_controls() {
    let script = browser_annotation_script(
        "__CETUS_BROWSER_ANNOTATION__test-token__",
        &BrowserAnnotationLabels::default(),
        true,
    );

    assert!(script.contains("if (isChrome(e.target)) return;"));
    assert!(script.contains("cancel.addEventListener(\"click\""));
    assert!(script.contains("setAnnotating(false);"));
    assert!(!script.contains("setAnnotating(true);\n    });"));
}

#[test]
fn browser_annotation_script_can_hide_floating_toggle() {
    let script = browser_annotation_script(
        "__CETUS_BROWSER_ANNOTATION__test-token__",
        &BrowserAnnotationLabels::default(),
        false,
    );

    assert!(!script.contains("<button id=\"cetus-browser-annotation-toggle\""));
    assert!(script.contains("window.addEventListener(\"cetus-browser-annotation-mode\""));
    assert!(script.contains("if (toggle)"));
}

#[test]
fn browser_surface_allows_web_about_and_file_urls() {
    for scheme in ["http", "https", "about", "file"] {
        assert!(supported_browser_scheme(scheme));
    }
    for scheme in ["javascript", "data", "chrome"] {
        assert!(!supported_browser_scheme(scheme));
    }
}
