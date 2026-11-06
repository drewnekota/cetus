//! `cetus` — the control-socket CLI. The `cetus` shim in the app data dir
//! execs this binary; it talks to the running app over `cetus.sock`.

#[path = "../../src/cli.rs"]
mod cli;

fn main() {
    // Accept both `cetus cli <verb>` (the legacy shim form) and bare verbs.
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("cli") {
        args.remove(0);
    }
    std::process::exit(cli::run(args));
}
