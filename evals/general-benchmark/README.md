# General Agent Benchmark

This benchmark targets desktop-agent use cases that overlap Cetus and the Codex
desktop app: local code work, review, shell verification, current web research,
data/artifact creation, memory, automations, browser control, computer control,
and local context recall.

The runnable cases are intentionally isolated under `workspaces/<case-id>` so
they can be sent to the real Tauri app through the devtest bridge without
touching the main repo. Gated cases stay in the suite as product coverage, but
require explicit local permissions or existing private data.

This is a smoke benchmark with local validators. A case is counted as passed
only when the bridge run completes and the case-specific checks pass, such as
test commands, required files, non-empty final answers, and expected evidence in
the output. It is not yet a full quality benchmark with LLM judging.

Run a smoke test:

```bash
node evals/general-benchmark/run.mjs --only fs-code-fix
```

Run all default runnable cases:

```bash
node evals/general-benchmark/run.mjs
```

Run gated cases explicitly:

```bash
node evals/general-benchmark/run.mjs --include-gated --only computer-use
```

Benchmark conversations are archived by default so the sidebar is not flooded.
Use `--keep-conversations` when debugging a specific run.

Prerequisites:

- Start the app with `pnpm app`.
- Make sure the model API key used by the app is configured.
- The bridge socket defaults to `/tmp/cetus-devtest.sock`.
