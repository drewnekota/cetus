#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if cetus_lib::chrome_use::maybe_run_native_host_from_args() {
        return;
    }
    cetus_lib::run()
}
