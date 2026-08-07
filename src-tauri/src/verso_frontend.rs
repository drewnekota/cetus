//! Production frontend transport for Verso.
//!
//! Verso can render Cetus correctly from an HTTP origin, but its current Tauri
//! runtime does not load the embedded `tauri://` asset protocol reliably. Serve
//! the exact same embedded Tauri assets on a loopback-only ephemeral port and
//! navigate the configured local windows there. No frontend components or
//! generated assets are changed.

use crate::AppHandle;

#[cfg(not(dev))]
pub fn start(app: &AppHandle) -> Result<tauri::Url, String> {
    use axum::{
        body::Body,
        extract::{OriginalUri, State},
        http::{header, Response, StatusCode},
        routing::get,
        Router,
    };
    async fn asset(State(app): State<AppHandle>, OriginalUri(uri): OriginalUri) -> Response<Body> {
        let requested = uri.path().trim_start_matches('/');
        let path = if requested.is_empty() {
            "index.html".to_string()
        } else {
            percent_encoding::percent_decode_str(requested)
                .decode_utf8_lossy()
                .into_owned()
        };
        let resolved = app.asset_resolver().get(path.clone()).or_else(|| {
            (!path.rsplit('/').next().unwrap_or_default().contains('.'))
                .then(|| app.asset_resolver().get("index.html".to_string()))
                .flatten()
        });
        let Some(asset) = resolved else {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::from("not found"))
                .unwrap();
        };
        let mut response = Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, asset.mime_type());
        if let Some(csp) = asset.csp_header {
            response = response.header(header::CONTENT_SECURITY_POLICY, csp);
        }
        response.body(Body::from(asset.bytes)).unwrap()
    }

    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| format!("failed to bind Verso frontend server: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("failed to configure Verso frontend server: {e}"))?;
    let address = listener
        .local_addr()
        .map_err(|e| format!("failed to read Verso frontend address: {e}"))?;
    let router = Router::new()
        .route("/", get(asset))
        .fallback(get(asset))
        .with_state(app.clone());
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                tracing::error!("failed to adopt Verso frontend listener: {error}");
                return;
            }
        };
        if let Err(error) = axum::serve(listener, router).await {
            tracing::error!("Verso frontend server stopped: {error}");
        }
    });
    tauri::Url::parse(&format!("http://{address}/"))
        .map_err(|e| format!("invalid Verso frontend URL: {e}"))
}

#[cfg(dev)]
pub fn start(_app: &AppHandle) -> Result<tauri::Url, String> {
    Err("the embedded frontend server is production-only".to_string())
}
