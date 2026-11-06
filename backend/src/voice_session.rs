//! Ownership and timing shared by capture, network and post-processing tasks.
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Instant;

#[derive(Clone)]
pub(crate) struct Session(Arc<SessionInner>);
struct SessionInner {
    id: u64,
    live: AtomicBool,
    failed: AtomicBool,
    started: Instant,
}
impl Session {
    pub fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self(Arc::new(SessionInner {
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            live: AtomicBool::new(true),
            failed: AtomicBool::new(false),
            started: Instant::now(),
        }))
    }
    pub fn id(&self) -> u64 {
        self.0.id
    }
    pub fn is_live(&self) -> bool {
        self.0.live.load(Ordering::Acquire)
    }
    pub fn cancel(&self) {
        self.0.live.store(false, Ordering::Release);
    }
    pub fn fail(&self) {
        self.0.failed.store(true, Ordering::Release);
    }
    pub fn failed(&self) -> bool {
        self.0.failed.load(Ordering::Acquire)
    }
    pub fn mark(&self, stage: &'static str) {
        tracing::info!(
            session_id = self.id(),
            stage,
            elapsed_ms = self.0.started.elapsed().as_millis() as u64,
            "voice timing"
        );
    }
}

/// Unlike a bare JoinHandle, dropping this owner cancels its child. Network
/// pumps/senders must not detach when their enclosing ASR future is cancelled.
pub(crate) struct Task<T>(tokio::task::JoinHandle<T>);
impl<T: Send + 'static> Task<T> {
    pub fn spawn(future: impl std::future::Future<Output = T> + Send + 'static) -> Self {
        Self(tokio::spawn(future))
    }
}
impl<T> Task<T> {
    pub fn abort(&self) {
        self.0.abort();
    }
}
impl<T> std::future::Future for Task<T> {
    type Output = Result<T, tokio::task::JoinError>;
    fn poll(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        std::pin::Pin::new(&mut self.0).poll(cx)
    }
}
impl<T> Drop for Task<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(crate) const CLEANUP_BUDGET: std::time::Duration = std::time::Duration::from_secs(2);

/// A single deadline covers context collection AND all model attempts.
pub(crate) async fn within_cleanup_budget<T>(
    future: impl std::future::Future<Output = T>,
) -> Option<T> {
    tokio::time::timeout(CLEANUP_BUDGET, future).await.ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelling_old_session_does_not_invalidate_new_session() {
        let old = Session::new();
        let late_callback = old.clone();
        let new = Session::new();
        old.cancel();
        assert!(!late_callback.is_live());
        assert!(new.is_live());
        assert_ne!(old.id(), new.id());
    }
    #[tokio::test]
    async fn dropping_parent_aborts_nested_task() {
        let (started, ready) = tokio::sync::oneshot::channel();
        let (ended, end) = tokio::sync::oneshot::channel::<()>();
        let parent = Task::spawn(async move {
            let child = Task::spawn(async move {
                let _held = ended;
                let _ = started.send(());
                std::future::pending::<()>().await;
            });
            let _ = child.await;
        });
        ready.await.unwrap();
        drop(parent);
        assert!(tokio::time::timeout(std::time::Duration::from_secs(1), end)
            .await
            .unwrap()
            .is_err());
    }
    #[tokio::test]
    async fn cleanup_budget_cancels_instead_of_accepting_late_result() {
        assert_eq!(
            within_cleanup_budget(async { "ready" }).await,
            Some("ready")
        );
        assert_eq!(
            within_cleanup_budget(std::future::pending::<String>()).await,
            None
        );
    }
}
