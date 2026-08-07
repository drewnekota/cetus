fn main() {
    tauri_runtime_verso_build::get_verso_as_external_bin()
        .expect("failed to download the Verso webview runtime");
    tauri_build::build()
}
