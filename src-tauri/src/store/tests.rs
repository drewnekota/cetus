use super::*;
use serde_json::json;

fn temp_store() -> (Store, PathBuf) {
    let path = std::env::temp_dir().join(format!("cetus-store-test-{}.db", uuid::Uuid::new_v4()));
    (Store::open(&path).unwrap(), path)
}

fn search_conv(id: &str, title: &str, archived: bool) -> Conversation {
    Conversation {
        id: id.into(),
        title: title.into(),
        session_file: String::new(),
        workspace_dir: "/tmp".into(),
        model: Default::default(),
        created_at: 1,
        updated_at: 1,
        archived_at: if archived { Some(5) } else { None },
        unread_at: None,
        pinned_at: None,
        source_automation_id: None,
        parallel_group_id: None,
        solution_index: None,
        review_state: "none".into(),
        backend: "claude-code".into(),
        cli_model: String::new(),
        cli_effort: String::new(),
        run_state: "idle".to_string(),
    }
}

#[test]
fn conversation_search_trigram_like_fallback_and_archived_filter() {
    let (store, path) = temp_store();
    store
        .insert(&search_conv("a", "Active chat", false))
        .unwrap();
    store.insert(&search_conv("b", "Old thread", true)).unwrap();
    store
        .upsert_conversation_index("a", "Active chat", "we talked about useChatStore here", 1)
        .unwrap();
    store
        .upsert_conversation_index("b", "Old thread", "关于归档搜索的讨论 and Rust", 1)
        .unwrap();

    // Both stale rows were indexed; nothing left for the sweep.
    assert!(store.stale_index_conversations(10).unwrap().is_empty());

    // Trigram MATCH: substring of an identifier, case-insensitive.
    let hits = store
        .search_conversations_raw("chatstore", None, 10)
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].0.id, "a");

    // Two-character CJK token → LIKE fallback.
    let hits = store.search_conversations_raw("归档", None, 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].0.id, "b");

    // Mixed long + short tokens, AND semantics.
    assert_eq!(
        store
            .search_conversations_raw("rust 归档", None, 10)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .search_conversations_raw("rust 缺失", None, 10)
            .unwrap()
            .len(),
        0
    );

    // Archived filter.
    assert_eq!(
        store
            .search_conversations_raw("thread", Some(false), 10)
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        store
            .search_conversations_raw("thread", Some(true), 10)
            .unwrap()
            .len(),
        1
    );

    // Bumping updated_at makes the row stale again; deleting clears it.
    store.set_archived("a", true, 9).unwrap();
    let stale = store.stale_index_conversations(10).unwrap();
    assert_eq!(
        stale.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        vec!["a"]
    );
    store.delete_conversation_index("b").unwrap();
    assert!(store
        .search_conversations_raw("thread", None, 10)
        .unwrap()
        .is_empty());
    std::fs::remove_file(path).ok();
}

#[test]
fn cli_messages_round_trip_retry_and_fork_copy() {
    let (store, path) = temp_store();

    // Turn 1: user (no prior resume) + assistant.
    store
        .append_cli_message(
            "c1",
            &json!({"role":"user","content":[{"type":"text","text":"first"}]}),
            None,
            1,
        )
        .unwrap();
    store
        .append_cli_message("c1", &json!({"role":"assistant","content":[]}), None, 2)
        .unwrap();
    // Turn 2: user resumed from sess-1.
    store
        .append_cli_message(
            "c1",
            &json!({"role":"user","content":[{"type":"text","text":"second"}]}),
            Some("sess-1"),
            3,
        )
        .unwrap();
    store
        .append_cli_message("c1", &json!({"role":"assistant","content":[]}), None, 4)
        .unwrap();

    let msgs = store.list_cli_messages("c1").unwrap();
    assert_eq!(msgs.len(), 4);

    // Retry contract: last user row carries its pre-turn resume token, and
    // deleting from it drops the whole failed turn.
    let (row_id, msg, resume) = store.last_cli_user_message("c1").unwrap().unwrap();
    assert_eq!(msg["content"][0]["text"], json!("second"));
    assert_eq!(resume.as_deref(), Some("sess-1"));
    store.delete_cli_messages_from("c1", row_id).unwrap();
    assert_eq!(store.list_cli_messages("c1").unwrap().len(), 2);

    // Fork copy honors the row limit; full copy takes everything.
    store.copy_cli_messages("c1", "c2", Some(1)).unwrap();
    assert_eq!(store.list_cli_messages("c2").unwrap().len(), 1);
    store.copy_cli_messages("c1", "c3", None).unwrap();
    assert_eq!(store.list_cli_messages("c3").unwrap().len(), 2);

    store.delete_cli_messages("c1").unwrap();
    assert!(store.list_cli_messages("c1").unwrap().is_empty());

    drop(store);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn run_state_sweep_and_dismiss() {
    let (store, path) = temp_store();
    let conv = Conversation {
        id: "c1".into(),
        title: String::new(),
        session_file: String::new(),
        workspace_dir: "/tmp".into(),
        model: Default::default(),
        created_at: 1,
        updated_at: 1,
        archived_at: None,
        unread_at: None,
        pinned_at: None,
        source_automation_id: None,
        parallel_group_id: None,
        solution_index: None,
        review_state: "none".into(),
        backend: "claude-code".into(),
        cli_model: String::new(),
        cli_effort: String::new(),
        run_state: "idle".to_string(),
    };
    store.insert(&conv).unwrap();

    // The boot/exit sweep only touches rows caught mid-run.
    store.set_run_state("c1", "running").unwrap();
    assert_eq!(store.mark_running_interrupted().unwrap(), 1);
    assert_eq!(store.get("c1").unwrap().unwrap().run_state, "interrupted");
    assert_eq!(store.mark_running_interrupted().unwrap(), 0);

    // Dismiss clears an interruption, but never a live/aborted state.
    store.clear_interrupted("c1").unwrap();
    assert_eq!(store.get("c1").unwrap().unwrap().run_state, "idle");
    store.set_run_state("c1", "aborted").unwrap();
    store.clear_interrupted("c1").unwrap();
    assert_eq!(store.get("c1").unwrap().unwrap().run_state, "aborted");

    drop(store);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn auto_resume_claim_is_one_shot_per_interruption() {
    let (store, path) = temp_store();
    let conv = Conversation {
        id: "c1".into(),
        title: String::new(),
        session_file: String::new(),
        workspace_dir: "/tmp".into(),
        model: Default::default(),
        created_at: 1,
        updated_at: 1,
        archived_at: None,
        unread_at: None,
        pinned_at: None,
        source_automation_id: None,
        parallel_group_id: None,
        solution_index: None,
        review_state: "none".into(),
        backend: "claude-code".into(),
        cli_model: String::new(),
        cli_effort: String::new(),
        run_state: "idle".to_string(),
    };
    store.insert(&conv).unwrap();

    // Nothing to claim while the row isn't interrupted.
    assert!(!store.claim_auto_resume("c1").unwrap());

    // First interruption: the claim succeeds exactly once.
    store.set_run_state("c1", "running").unwrap();
    store.mark_running_interrupted().unwrap();
    assert!(store.claim_auto_resume("c1").unwrap());
    assert!(!store.claim_auto_resume("c1").unwrap());

    // The resumed run gets cut down again before settling → no second
    // automatic retry (banner territory).
    store.set_run_state("c1", "running").unwrap();
    store.mark_running_interrupted().unwrap();
    assert!(!store.claim_auto_resume("c1").unwrap());

    // A settled turn (idle) refunds the budget for the next incident…
    store.set_run_state("c1", "running").unwrap();
    store.set_run_state("c1", "idle").unwrap();
    store.set_run_state("c1", "running").unwrap();
    store.mark_running_interrupted().unwrap();
    assert!(store.claim_auto_resume("c1").unwrap());

    // …and so does dismissing the banner.
    store.set_run_state("c1", "running").unwrap();
    store.mark_running_interrupted().unwrap();
    store.clear_interrupted("c1").unwrap();
    store.set_run_state("c1", "running").unwrap();
    store.mark_running_interrupted().unwrap();
    assert!(store.claim_auto_resume("c1").unwrap());

    drop(store);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn switch_backend_stashes_and_restores_resume_tokens() {
    let (store, path) = temp_store();
    let conv = Conversation {
        id: "c1".into(),
        title: String::new(),
        session_file: String::new(),
        workspace_dir: "/tmp".into(),
        model: Default::default(),
        created_at: 1,
        updated_at: 1,
        archived_at: None,
        unread_at: None,
        pinned_at: None,
        source_automation_id: None,
        parallel_group_id: None,
        solution_index: None,
        review_state: "none".into(),
        backend: "codex".into(),
        cli_model: String::new(),
        cli_effort: String::new(),
        run_state: "idle".to_string(),
    };
    store.insert(&conv).unwrap();
    store.set_session_file("c1", "codex-thread-1").unwrap();

    // codex → claude: the codex token is stashed, claude starts blank.
    assert_eq!(
        store.switch_backend("c1", "claude-code", 2).unwrap(),
        Some("codex".to_string())
    );
    let c = store.get("c1").unwrap().unwrap();
    assert_eq!(c.backend, "claude-code");
    assert_eq!(c.session_file, "");

    // Claude runs a turn and persists its own token.
    store.set_session_file("c1", "claude-sess-1").unwrap();

    // claude → codex: claude's token is stashed, codex's restored.
    assert_eq!(
        store.switch_backend("c1", "codex", 3).unwrap(),
        Some("claude-code".to_string())
    );
    let c = store.get("c1").unwrap().unwrap();
    assert_eq!(c.session_file, "codex-thread-1");

    // Back again: claude's token round-trips too.
    store.switch_backend("c1", "claude-code", 4).unwrap();
    let c = store.get("c1").unwrap().unwrap();
    assert_eq!(c.session_file, "claude-sess-1");

    // ACP runtimes use the same per-runtime token map.
    store.switch_backend("c1", "opencode", 5).unwrap();
    assert_eq!(store.get("c1").unwrap().unwrap().session_file, "");
    store.set_session_file("c1", "opencode-session-1").unwrap();
    store.switch_backend("c1", "kimi", 6).unwrap();
    store.set_session_file("c1", "kimi-session-1").unwrap();
    store.switch_backend("c1", "opencode", 7).unwrap();
    assert_eq!(
        store.get("c1").unwrap().unwrap().session_file,
        "opencode-session-1"
    );

    // Same backend / missing conversation: no-op.
    assert_eq!(store.switch_backend("c1", "opencode", 8).unwrap(), None);
    assert_eq!(store.switch_backend("nope", "codex", 5).unwrap(), None);

    drop(store);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn unread_marker_persists_and_clears_on_archive() {
    let (store, path) = temp_store();
    let conv = Conversation {
        id: "c1".into(),
        title: String::new(),
        session_file: String::new(),
        workspace_dir: "/tmp".into(),
        model: Default::default(),
        created_at: 1,
        updated_at: 1,
        archived_at: None,
        unread_at: None,
        pinned_at: None,
        source_automation_id: None,
        parallel_group_id: None,
        solution_index: None,
        review_state: "none".into(),
        backend: "pi".into(),
        cli_model: String::new(),
        cli_effort: String::new(),
        run_state: "idle".to_string(),
    };
    store.insert(&conv).unwrap();

    store.set_unread("c1", Some(42)).unwrap();
    let c = store.get("c1").unwrap().unwrap();
    assert_eq!(c.unread_at, Some(42));
    // Reading a chat is not activity: the sidebar order and the auto-archive
    // idle clock must not move.
    assert_eq!(c.updated_at, 1);

    store.set_unread("c1", None).unwrap();
    assert_eq!(store.get("c1").unwrap().unwrap().unread_at, None);

    // Archiving by hand dismisses the dot, so a restore comes back clean.
    store.set_unread("c1", Some(42)).unwrap();
    store.set_archived("c1", true, 99).unwrap();
    assert_eq!(store.get("c1").unwrap().unwrap().unread_at, None);

    drop(store);
    let _ = std::fs::remove_file(&path);
}
