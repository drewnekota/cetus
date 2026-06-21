# Upgraded General Agent Benchmark Fixtures

This directory contains concrete fixture data and a runner for the upgraded
benchmark described in `../upgraded-benchmark.html`.

Each case has:

- an entry in `cases.json`
- a concrete `fixtures/<case-id>/` directory
- an `expected.json` file that documents validator expectations
- runner support in `run.mjs`

The first case, `repair-regression-with-minimal-diff`, is a complete runnable
mini repo:

```bash
cd evals/general-benchmark/v2/fixtures/repair-regression-with-minimal-diff
npm test
```

It should fail before the agent fixes the implementation.

Prepare isolated workspaces for all ten cases:

```bash
node evals/general-benchmark/v2/run.mjs --setup-only --include-gated
```

Run the default non-gated cases through the Cetus devtest bridge:

```bash
node evals/general-benchmark/v2/run.mjs
```

Run gated cases explicitly:

```bash
node evals/general-benchmark/v2/run.mjs --include-gated --only visible-browser-form-inspection
```

Results are written to timestamped JSON files under `results/`, with
`results/latest.json` updated on each run. Runtime workspaces are written under
`workspaces/`; both directories are ignored by git.

The default runnable set is:

- `repair-regression-with-minimal-diff`
- `unsafe-migration-review`
- `messy-data-exec-brief`
- `current-docs-with-source-conflict`
- `offline-board-artifact`
- `bridge-permission-recovery`

The gated set is:

- `visible-browser-form-inspection`
- `calculator-nonintrusive-ax-audit`
- `memory-automation-combined`
- `local-context-triangulation`
