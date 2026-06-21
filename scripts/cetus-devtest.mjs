#!/usr/bin/env node
// cetus devtest CLI (M4)
// -----------------------------------------------------------------------------
// Zero-dependency Node client for the DEV-ONLY cetus devtest UDS bridge.
//
// It connects to the Unix-domain socket exposed by a `--features devtest` build
// of cetus (when launched with CETUS_DEVTEST=1 or $CETUS_DEVTEST_SOCK set), sends
// ONE newline-delimited JSON request built from argv, prints the JSON response,
// and exits. There is NO TCP — this is a filesystem socket, dev-only.
//
// Socket path resolution (must match devtest.rs::start_uds_server):
//   1. $CETUS_DEVTEST_SOCK if set, else
//   2. <app_data_dir>/cetus-devtest.sock
// On macOS the default app_data_dir for cetus is typically:
//   ~/Library/Application Support/<bundle-identifier>/cetus-devtest.sock
// If you don't know the bundle id, prefer launching cetus with an explicit
//   CETUS_DEVTEST_SOCK=/tmp/cetus-devtest.sock
// and pass the same value here (env or --sock).
//
// Usage:
//   node scripts/cetus-devtest.mjs ping
//   node scripts/cetus-devtest.mjs screenshot > /tmp/shot.json
//   node scripts/cetus-devtest.mjs eval --label main --js "document.title"
//     (eval is fire-and-forget; use a dom/eval op to read a value back)
//   node scripts/cetus-devtest.mjs find  --selector '[data-testid="agent-control-card"]'
//   node scripts/cetus-devtest.mjs click --selector '[data-testid="nav-agent-control"]'
//   node scripts/cetus-devtest.mjs type  --selector 'input#prompt' --text "hello"
//   node scripts/cetus-devtest.mjs getText --selector 'h1'
//   node scripts/cetus-devtest.mjs dump
//   node scripts/cetus-devtest.mjs dom --op eval --js "document.querySelector('h1')?.textContent"
//   node scripts/cetus-devtest.mjs ax --request '{"action":"tree","params":{}}'
//   node scripts/cetus-devtest.mjs computerObserve --request '{"op":"dump","includeScreenshot":true}'
//   node scripts/cetus-devtest.mjs chromeHostSelfTest
//   node scripts/cetus-devtest.mjs chromeStatus
//   node scripts/cetus-devtest.mjs browserOpen --url about:blank
//   node scripts/cetus-devtest.mjs browserPanelOpen --url about:blank
//   node scripts/cetus-devtest.mjs browserPanelClose
//   node scripts/cetus-devtest.mjs browserAnnotate --payload '{"url":"about:blank","title":"","xPct":50,"yPct":50,"note":"test"}'
//   node scripts/cetus-devtest.mjs browserVisibleOpen --url about:blank
//   node scripts/cetus-devtest.mjs webviews
//   node scripts/cetus-devtest.mjs agentSettings --payload '{"browser":true,"computer":true}'
//   node scripts/cetus-devtest.mjs agentPrompt --text "Say hi" --workspace /tmp/cetus-eval --timeout 300000
//
// Options (any op):
//   --sock <path>     override socket path (else $CETUS_DEVTEST_SOCK / default)
//   --id <value>      request id (default: a generated number)
//   --selector <css>  CSS selector (dom/find/click/type/getText)
//   --text <string>   text payload (type)
//   --workspace <dir> workspace for agentPrompt (defaults to Cetus default workspace)
//   --archive         archive the conversation after agentPrompt completes
//   --js <string>     JavaScript source (eval / dom op=eval)
//   --label <string>  webview label (eval/screenshot; default "main")
//   --op <name>       dom op name (only for the literal `dom` op)
//   --request <json>  raw JSON for the `ax` op (a CuaRequest)
//   --url <url>       URL payload (browserOpen)
//   --payload <json>  raw JSON payload (browserAnnotate)
//   --timeout <ms>    client read timeout (default 15000)
// -----------------------------------------------------------------------------

import net from "node:net";
import os from "node:os";
import path from "node:path";

const OPS = new Set([
  "ping",
  "eval",
  "screenshot",
  "ax",
  "computerObserve",
  "chromeHostSelfTest",
  "chromeStatus",
  "dom",
  "find",
  "click",
  "type",
  "getText",
  "dump",
  "browserOpen",
  "browserPanelOpen",
  "browserPanelClose",
  "browserAnnotate",
  "browserVisibleOpen",
  "webviews",
  "agentSettings",
  "agentPrompt",
]);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function defaultSocketPath() {
  if (process.env.CETUS_DEVTEST_SOCK) return process.env.CETUS_DEVTEST_SOCK;
  // `pnpm app` sets CETUS_DEVTEST_SOCK=/tmp/cetus-devtest.sock, which is the
  // canonical dev path. Fall back to the Tauri app_data_dir location for
  // builds started without the env (bundle id: dev.cetus.app).
  if (process.platform === "darwin") {
    return "/tmp/cetus-devtest.sock";
  }
  // Linux-ish fallback (XDG data dir).
  const dataHome =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "cetus", "cetus-devtest.sock");
}

function buildRequest(op, args) {
  const id =
    args.id !== undefined ? args.id : Math.floor(Date.now() % 1e9);
  const req = { id, op };
  if (args.selector !== undefined) req.selector = args.selector;
  if (args.text !== undefined) req.text = args.text;
  if (args.workspace !== undefined) req.workspace = args.workspace;
  if (args.archive !== undefined) req.archive = Boolean(args.archive);
  if (args.js !== undefined) req.js = args.js;
  if (args.label !== undefined) req.label = args.label;
  if (args.url !== undefined) req.url = args.url;

  // `dom` is a passthrough: the actual DOM op name comes from --op.
  if (op === "dom") {
    if (args.op === undefined) {
      fail("dom requires --op <find|click|type|getText|eval|dump>");
    }
    req.op = args.op;
  }

  // AX/computer ops take a raw JSON request via --request.
  if (op === "ax" || op === "computerObserve") {
    if (args.request === undefined) {
      fail(`${op} requires --request '{"op":"dump"}'`);
    }
    try {
      req.request = JSON.parse(args.request);
    } catch (e) {
      fail(`--request is not valid JSON: ${e.message}`);
    }
  }

  if (op === "browserAnnotate") {
    if (args.payload === undefined) {
      fail('browserAnnotate requires --payload \'{"url":"...","title":"...","xPct":50,"yPct":50,"note":"..."}\'');
    }
    try {
      req.payload = JSON.parse(args.payload);
    } catch (e) {
      fail(`--payload is not valid JSON: ${e.message}`);
    }
  }

  if (op === "agentSettings" && args.payload !== undefined) {
    try {
      req.settings = JSON.parse(args.payload);
    } catch (e) {
      fail(`--payload is not valid JSON: ${e.message}`);
    }
  }

  return req;
}

function fail(msg, code = 2) {
  process.stderr.write(`cetus-devtest: ${msg}\n`);
  process.exit(code);
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const op = args._[0];

  if (!op || args.help) {
    process.stderr.write(
      "Usage: node scripts/cetus-devtest.mjs <op> [options]\n" +
        `  ops: ${[...OPS].join(", ")}\n` +
        "  see header comment for examples\n",
    );
    process.exit(op ? 0 : 2);
  }
  if (!OPS.has(op)) {
    fail(`unknown op "${op}"; expected one of: ${[...OPS].join(", ")}`);
  }

  const sockPath = args.sock || defaultSocketPath();
  const timeoutMs = Number(args.timeout || 15000);
  const request = buildRequest(op, args);

  const sock = net.createConnection({ path: sockPath });
  let buf = "";
  let done = false;

  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    sock.destroy();
    fail(`timed out after ${timeoutMs}ms waiting for a response`, 4);
  }, timeoutMs);

  sock.on("connect", () => {
    sock.write(JSON.stringify(request) + "\n");
  });

  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const nl = buf.indexOf("\n");
    if (nl !== -1 && !done) {
      done = true;
      clearTimeout(timer);
      const line = buf.slice(0, nl);
      sock.end();
      try {
        const parsed = JSON.parse(line);
        process.stdout.write(JSON.stringify(parsed) + "\n");
        process.exit(parsed && parsed.ok === false ? 1 : 0);
      } catch {
        // Not JSON — print raw so the caller can debug.
        process.stdout.write(line + "\n");
        process.exit(0);
      }
    }
  });

  sock.on("error", (err) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (err && (err.code === "ENOENT" || err.code === "ECONNREFUSED")) {
      fail(
        "cetus devtest socket not found — is cetus running with " +
          "--features devtest and CETUS_DEVTEST=1?\n" +
          `  tried socket: ${sockPath}\n` +
          "  (set CETUS_DEVTEST_SOCK to a known path on both cetus and this CLI)",
        3,
      );
    }
    fail(`socket error: ${err && err.message ? err.message : String(err)}`, 3);
  });

  sock.on("close", () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    fail("connection closed before a response was received", 5);
  });
}

main();
