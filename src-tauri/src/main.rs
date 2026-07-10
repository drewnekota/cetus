#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `Cetus cli …` is the control-socket CLI (the `cetus` shim in the app
    // data dir execs this) — handle it before any Tauri init so it stays a
    // plain instant CLI. A GUI launch never passes args, so this can't hijack
    // the app (macOS "Open with parameters" doesn't use argv either).
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("cli") {
        args.remove(0);
        std::process::exit(cetus_lib::cli::run(args));
    }
    cetus_lib::run()
}
