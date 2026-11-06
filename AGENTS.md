# Repository instructions

## Releases

- `package.json` `version` is the single source of the app version (the
  Electron bundle, the updater feed and the pi sidecar stamp all read it).
  Before publishing a new release, increment it there.
- A release must use a version newer than the version currently published in
  `release/latest.json`.
- Releases are macOS (Apple Silicon) only; `latest.json` carries only the
  `darwin-aarch64` entry.
- After publishing, verify that `release/latest.json`, the release asset names,
  and the `release` Git tag all identify the intended version and commit.
