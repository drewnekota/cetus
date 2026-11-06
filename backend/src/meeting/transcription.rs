use super::{
    append_recall, emit_caption, now_ms, AppHandle, Arc, AtomicI64, CloudAsrChannels, Ordering,
    Path, PathBuf, Store,
};

#[cfg(target_os = "macos")]
pub(super) fn spawn_cloud_asr(
    app: AppHandle,
    store: Arc<Store>,
    app_data: &Path,
    id: String,
    recall: PathBuf,
    app_hint: Option<String>,
    segments: Arc<AtomicI64>,
) -> CloudAsrChannels {
    let key = crate::secrets::get("doubao")
        .ok()
        .flatten()
        .unwrap_or_default();
    let resource = crate::doubao::DEFAULT_RESOURCE_ID.to_string();
    // Same personal-vocabulary biasing as dictation (manual word list +
    // correction-confirmed + learned + memory terms), minus the focused-field
    // context — a meeting-start snapshot of whatever field happens to be
    // focused would be stale and off-topic for the whole call. Both streams
    // share one corpus: "Them" says the same proper nouns back at you.
    let quick_settings = crate::quick::load_settings(&store);
    let corpus = if quick_settings.voice_context_biasing {
        crate::doubao::Corpus {
            hotwords: crate::biasing::hotwords(app_data, &quick_settings.voice_hotwords),
            ..Default::default()
        }
    } else {
        crate::doubao::Corpus::default()
    };
    let (mic_tx, mic_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    let (system_tx, system_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    let mut tasks = Vec::new();
    for (source, rx) in [("mic", mic_rx), ("system", system_rx)] {
        let key = key.clone();
        let resource = resource.clone();
        let corpus = corpus.clone();
        let store = store.clone();
        let id = id.clone();
        let recall = recall.clone();
        let app_hint = app_hint.clone();
        let segments = segments.clone();
        let app = app.clone();
        tasks.push(tokio::spawn(async move {
            let store_for_sentence = store.clone();
            let id_for_sentence = id.clone();
            let recall_for_sentence = recall.clone();
            let hint_for_sentence = app_hint.clone();
            let app_for_sentence = app.clone();
            let on_sentence = move |text: &str| {
                let text = text.trim();
                if text.is_empty() {
                    return;
                }
                let ts = now_ms();
                emit_caption(
                    &app_for_sentence,
                    &id_for_sentence,
                    source,
                    "final",
                    ts,
                    text,
                );
                if let Err(e) =
                    store_for_sentence.insert_meeting_segment(&id_for_sentence, ts, source, text)
                {
                    tracing::warn!("meeting: cloud segment insert failed: {e}");
                    return;
                }
                append_recall(
                    &recall_for_sentence,
                    ts,
                    "segment",
                    source,
                    hint_for_sentence.as_deref(),
                    None,
                    text,
                );
                segments.fetch_add(1, Ordering::Relaxed);
            };
            let app_for_partial = app.clone();
            let id_for_partial = id.clone();
            // Doubao interims already arrive per server frame (a few per
            // second) — no extra throttle needed on top.
            let on_partial = move |text: &str| {
                emit_caption(
                    &app_for_partial,
                    &id_for_partial,
                    source,
                    "partial",
                    now_ms(),
                    text,
                );
            };
            if let Err(e) = crate::doubao::stream_hands_free(
                &key,
                &resource,
                corpus,
                rx,
                on_partial,
                on_sentence,
            )
            .await
            {
                tracing::warn!("meeting: {source} cloud ASR failed: {e}");
            }
        }));
    }
    (mic_tx, system_tx, tasks)
}
