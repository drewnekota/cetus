use super::*;

#[test]
fn explicit_marker_promotes_unknown_local_file_type() {
    let dir = artifact_test_dir("unknown");
    let file = dir.join("scene.blend");
    std::fs::write(&file, b"blend-data").unwrap();
    let marker = format!(
        "CETUS_ARTIFACT:{}",
        json!({ "path": file.to_string_lossy() })
    );
    let details = extracted_artifact_details(&json!(marker), Some(&dir), Some(&dir)).unwrap();
    assert_eq!(details["artifactKind"], json!("other"));
    assert_eq!(details["mimeType"], json!("application/octet-stream"));
    assert_eq!(details["name"], json!("scene.blend"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn prose_paths_are_not_promoted_to_artifacts() {
    let dir = artifact_test_dir("prose-path");
    let file = dir.join("runtime.dmg");
    std::fs::write(&file, b"disk-image").unwrap();
    for text in [
        format!("Image Path: {}", file.display()),
        format!("Created file: {}", file.display()),
        format!("Report saved to {}", file.display()),
    ] {
        assert!(
            extracted_artifact_details(&json!(text), Some(&dir), Some(&dir)).is_none(),
            "plain tool prose must not imply artifact delivery"
        );
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn tool_media_and_paths_are_not_deliveries() {
    let dir = artifact_test_dir("observations");
    let file = dir.join("crop.png");
    std::fs::write(&file, b"fake-png").unwrap();
    let encoded = base64::engine::general_purpose::STANDARD.encode(b"fake-png");
    for value in [
        json!({ "type": "image", "data": encoded, "mimeType": "image/png" }),
        json!({ "type": "input_file", "data": encoded, "mimeType": "text/plain" }),
        json!({ "type": "image", "source": { "type": "base64", "data": encoded } }),
        json!({ "type": "input_image", "image_url": format!("data:image/png;base64,{encoded}") }),
        json!(format!("data:image/png;base64,{encoded}")),
        json!({ "type": "file", "path": file }),
        json!({ "output_path": file }),
    ] {
        assert!(extracted_artifact_details(&value, Some(&dir), Some(&dir)).is_none());
    }
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn explicit_structured_artifact_is_delivered() {
    let dir = artifact_test_dir("explicit-image");
    let file = dir.join("answer.png");
    std::fs::write(&file, b"fake-png").unwrap();
    let details = artifact_details(&file, None, Some("Answer")).unwrap();
    assert_eq!(
        extracted_artifact_details(&json!({ "details": details }), Some(&dir), Some(&dir)),
        Some(details)
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn codex_image_generation_requires_explicit_delivery() {
    let dir = artifact_test_dir("codex-image");
    let mut tr =
        EventTranslator::new(CliBackend::Codex).with_artifact_storage(dir.clone(), dir.clone());
    let encoded = base64::engine::general_purpose::STANDARD.encode(b"fake-png");
    let item = normalize_codex_app_item(
        json!({ "type": "imageGeneration", "id": "img-1", "result": encoded }),
    );
    let events = tr.on_line(&json!({ "type": "item.completed", "item": item }).to_string());
    let end = events
        .iter()
        .find(|event| event["type"] == "tool_execution_end")
        .unwrap();
    assert!(end["result"]["details"].is_null());
    assert_eq!(
        end["result"]["content"][0]["text"],
        json!("[Media returned to agent]")
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn dynamic_tool_can_deliver_multiple_file_types() {
    let dir = artifact_test_dir("collection");
    let pdf = dir.join("report.pdf");
    let archive = dir.join("bundle.xyz");
    std::fs::write(&pdf, b"pdf").unwrap();
    std::fs::write(&archive, b"other").unwrap();
    let mut tr =
        EventTranslator::new(CliBackend::Codex).with_artifact_storage(dir.clone(), dir.clone());
    let item = normalize_codex_app_item(json!({
        "type": "dynamicToolCall",
        "id": "tool-1",
        "tool": "export",
        "arguments": {},
        "contentItems": [
            { "type": "text", "text": format!("CETUS_ARTIFACT:{}", json!({ "path": pdf })) },
            { "type": "text", "text": format!("CETUS_ARTIFACT:{}", json!({ "path": archive })) }
        ],
        "success": true
    }));
    let events = tr.on_line(&json!({ "type": "item.completed", "item": item }).to_string());
    let end = events
        .iter()
        .find(|event| event["type"] == "tool_execution_end")
        .unwrap();
    let artifacts = end["result"]["details"]["artifacts"].as_array().unwrap();
    assert_eq!(artifacts.len(), 2);
    assert_eq!(artifacts[0]["artifactKind"], json!("pdf"));
    assert_eq!(artifacts[1]["artifactKind"], json!("other"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn claude_artifact_marker_is_promoted_from_bash_result() {
    let dir = artifact_test_dir("claude-marker");
    let file = dir.join("deck.pptx");
    std::fs::write(&file, b"slides").unwrap();
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode)
        .with_artifact_storage(dir.clone(), dir.clone());
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"bash-1","name":"Bash","input":{}}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
    let marker = format!(
        "CETUS_ARTIFACT:{}",
        json!({ "path": file.to_string_lossy() })
    );
    let events = tr.on_line(
        &json!({
            "type": "user",
            "message": { "content": [{
                "type": "tool_result",
                "tool_use_id": "bash-1",
                "content": marker,
                "is_error": false
            }]}
        })
        .to_string(),
    );
    let end = events
        .iter()
        .find(|event| event["type"] == "tool_execution_end")
        .unwrap();
    assert_eq!(end["result"]["details"]["name"], json!("deck.pptx"));
    assert_eq!(end["result"]["details"]["artifactKind"], json!("other"));
    let _ = std::fs::remove_dir_all(dir);
}

/// claude ≥2.1.210 runs foreground Bash through the task lifecycle too
/// (task_started/task_notification with task_type local_bash, then the
/// real tool_result). The task-settle path must still promote artifact
/// markers, or a `cetus artifact` delivery renders no file card.
#[test]
fn claude_artifact_marker_survives_foreground_bash_task_lifecycle() {
    let dir = artifact_test_dir("claude-task-marker");
    let file = dir.join("deck.pdf");
    std::fs::write(&file, b"%PDF-").unwrap();
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode)
        .with_artifact_storage(dir.clone(), dir.clone());
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"bash-1","name":"Bash","input":{}}}}"#);
    tr.on_line(r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#);
    // Real order captured from claude 2.1.211: both task events land
    // before the main-chain tool_result.
    tr.on_line(r#"{"type":"system","subtype":"task_started","task_id":"fg1","tool_use_id":"bash-1","description":"Deliver PDF","task_type":"local_bash"}"#);
    tr.on_line(r#"{"type":"system","subtype":"task_notification","task_id":"fg1","tool_use_id":"bash-1","status":"completed","summary":"Deliver PDF"}"#);
    let marker = format!(
        "CETUS_ARTIFACT:{}",
        json!({ "path": file.to_string_lossy() })
    );
    let events = tr.on_line(
        &json!({
            "type": "user",
            "message": { "content": [{
                "type": "tool_result",
                "tool_use_id": "bash-1",
                "content": marker,
                "is_error": false
            }]}
        })
        .to_string(),
    );
    let end = events
        .iter()
        .find(|event| event["type"] == "tool_execution_end")
        .unwrap();
    assert_eq!(end["result"]["details"]["subagent"]["type"], json!("Bash"));
    assert_eq!(
        end["result"]["details"]["artifacts"]["artifactKind"],
        json!("pdf")
    );
    // The persisted transcript row must match what the card shows.
    let row = tr
        .messages
        .iter()
        .find(|m| m["toolCallId"] == json!("bash-1"))
        .unwrap();
    assert_eq!(row["details"]["artifacts"]["name"], json!("deck.pdf"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn every_preview_category_and_unknown_extension_is_supported() {
    let dir = artifact_test_dir("kinds");
    for (name, expected) in [
        ("image.png", "image"),
        ("movie.mp4", "video"),
        ("sound.wav", "audio"),
        ("paper.pdf", "pdf"),
        ("notes.md", "markdown"),
        ("page.html", "html"),
        ("data.csv", "text"),
        ("workbook.xlsx", "other"),
        ("anything.custom", "other"),
    ] {
        let path = dir.join(name);
        std::fs::write(&path, b"x").unwrap();
        assert_eq!(
            artifact_details(&path, None, None).unwrap()["artifactKind"],
            json!(expected)
        );
    }
    let _ = std::fs::remove_dir_all(dir);
}
