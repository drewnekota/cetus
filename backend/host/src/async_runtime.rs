//! Shared tokio runtime for commands and spawned tasks.

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

use once_cell::sync::Lazy;

static RUNTIME: Lazy<tokio::runtime::Runtime> = Lazy::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("cetus-async")
        .build()
        .expect("tokio runtime")
});

pub fn handle() -> tokio::runtime::Handle {
    RUNTIME.handle().clone()
}

/// Enter the runtime on the current thread for the rest of its life, so
/// `tokio::spawn` works from main-thread (sync command) code too.
pub fn enter_forever() {
    std::mem::forget(RUNTIME.enter());
}

pub struct JoinHandle<T>(tokio::task::JoinHandle<T>);

impl<T> JoinHandle<T> {
    pub fn abort(&self) {
        self.0.abort();
    }
    pub fn inner(&self) -> &tokio::task::JoinHandle<T> {
        &self.0
    }
}

impl<T> Future for JoinHandle<T> {
    type Output = crate::Result<T>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.0)
            .poll(cx)
            .map_err(|e| crate::Error(e.to_string()))
    }
}

pub fn spawn<F>(fut: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    JoinHandle(RUNTIME.spawn(fut))
}

pub fn spawn_blocking<F, R>(f: F) -> JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    JoinHandle(RUNTIME.spawn_blocking(f))
}

pub fn block_on<F: Future>(fut: F) -> F::Output {
    match tokio::runtime::Handle::try_current() {
        Ok(h) => tokio::task::block_in_place(|| h.block_on(fut)),
        Err(_) => RUNTIME.block_on(fut),
    }
}
