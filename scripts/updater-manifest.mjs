#!/usr/bin/env node
// Build and check the updater feed (`latest.json`) that release.yml publishes.
// The format is the Tauri updater's, which the in-app updater
// (backend/host/src/updater.rs) reads. Cetus ships for macOS (Apple Silicon)
// only, so the manifest carries exactly one platform: darwin-aarch64.
//
//   node scripts/updater-manifest.mjs create --output <file> --version <x.y.z>
//     --pub-date <iso> --mac-url <url> --mac-signature-file <file.sig>
//   node scripts/updater-manifest.mjs verify --manifest <file> --version <x.y.z>

import fs from "node:fs";
import path from "node:path";

const PLATFORM_KEYS = ["darwin-aarch64"];

function fail(message) {
  process.stderr.write(`updater-manifest: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = {};

  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`invalid argument list near ${key ?? "<end>"}`);
    }
    values[key.slice(2)] = value;
  }

  return { command, values };
}

function required(values, key) {
  const value = values[key]?.trim();
  if (!value) fail(`missing --${key}`);
  return value;
}

function readSignature(file) {
  const signature = fs.readFileSync(file, "utf8").trim();
  if (!signature) fail(`empty signature file: ${file}`);
  return signature;
}

function validateManifest(manifest, expectedVersion) {
  if (!manifest || typeof manifest !== "object") {
    fail("manifest root must be an object");
  }
  if (manifest.version !== expectedVersion) {
    fail(
      `manifest version ${JSON.stringify(manifest.version)} does not match ${expectedVersion}`,
    );
  }
  if (!manifest.pub_date || Number.isNaN(Date.parse(manifest.pub_date))) {
    fail("manifest pub_date is missing or invalid");
  }

  const keys = Object.keys(manifest.platforms ?? {}).sort();
  if (keys.join(",") !== PLATFORM_KEYS.join(",")) {
    fail(
      `manifest platforms must be exactly ${PLATFORM_KEYS.join(", ")}; got ${keys.join(", ") || "none"}`,
    );
  }

  for (const platform of keys) {
    const entry = manifest.platforms[platform];
    if (!entry?.signature?.trim()) {
      fail(`${platform} signature is missing`);
    }
    let url;
    try {
      url = new URL(entry.url);
    } catch {
      fail(`${platform} URL is invalid`);
    }
    if (url.protocol !== "https:") {
      fail(`${platform} URL must use HTTPS`);
    }
  }
}

const { command, values } = parseArgs(process.argv.slice(2));

if (command === "create") {
  const output = required(values, "output");
  const version = required(values, "version");
  const manifest = {
    version,
    notes: "See the GitHub release page for details.",
    pub_date: required(values, "pub-date"),
    platforms: {
      "darwin-aarch64": {
        signature: readSignature(required(values, "mac-signature-file")),
        url: required(values, "mac-url"),
      },
    },
  };

  validateManifest(manifest, version);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`created ${output} for ${version}\n`);
} else if (command === "verify") {
  const file = required(values, "manifest");
  const version = required(values, "version");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  validateManifest(manifest, version);
  process.stdout.write(
    `verified ${file}: ${version}, ${Object.keys(manifest.platforms).join(", ")}\n`,
  );
} else {
  fail("expected command: create or verify");
}
