#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Top-level `cli::run_inner` verbs, accepted without the `cli` prefix. Kept in
/// sync with the match there — an entry missing here doesn't break the shim, it
/// just costs that verb the bare-invocation path below.
const CLI_VERBS: &[&str] = &[
    "help", "--help", "-h", "ping", "version", "artifact", "cron", "context",
];

fn main() {
    // `Cetus cli …` is the control-socket CLI (the `cetus` shim in the app
    // data dir execs this) — handle it before any Tauri init so it stays a
    // plain instant CLI. A GUI launch never passes args, so this can't hijack
    // the app (macOS "Open with parameters" doesn't use argv either).
    //
    // Bare verbs (`cetus artifact …`) take the same path. Callers that reach
    // the app binary directly instead of through the shim would otherwise fall
    // through to `run()` and boot a whole second GUI instance — an extra dock
    // icon plus a duplicate meeting-helper pair — that never exits, since the
    // CLI's fire-and-exit contract is nowhere in that path.
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("cli") => {
            args.remove(0);
            std::process::exit(cetus_lib::cli::run(args));
        }
        // Unknown args still fall through to the GUI: this list gates who gets
        // the CLI, and `cli::run` rejects anything it doesn't recognize.
        Some(verb) if CLI_VERBS.contains(&verb) => {
            std::process::exit(cetus_lib::cli::run(args));
        }
        _ => {}
    }
    cetus_lib::run()
}
