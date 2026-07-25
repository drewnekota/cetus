#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const PLATFORM_KEYS = ["darwin-aarch64", "windows-x86_64"];

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
  if (JSON.stringify(keys) !== JSON.stringify([...PLATFORM_KEYS].sort())) {
    fail(`manifest platforms must be exactly: ${PLATFORM_KEYS.join(", ")}`);
  }

  for (const platform of PLATFORM_KEYS) {
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

function validateMergeSource(manifest, expectedVersion, replacedPlatform) {
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

  const preservedPlatform = PLATFORM_KEYS.find(
    (platform) => platform !== replacedPlatform,
  );
  const preservedEntry = manifest.platforms?.[preservedPlatform];
  if (!preservedEntry?.signature?.trim()) {
    fail(`${preservedPlatform} must already exist before a single-platform merge`);
  }
  try {
    const url = new URL(preservedEntry.url);
    if (url.protocol !== "https:") throw new Error("not HTTPS");
  } catch {
    fail(`${preservedPlatform} URL is invalid`);
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
      "windows-x86_64": {
        signature: readSignature(required(values, "windows-signature-file")),
        url: required(values, "windows-url"),
      },
    },
  };

  validateManifest(manifest, version);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`created ${output} for ${version}\n`);
} else if (command === "merge") {
  const file = required(values, "manifest");
  const output = required(values, "output");
  const version = required(values, "version");
  const platform = required(values, "platform");
  if (!PLATFORM_KEYS.includes(platform)) {
    fail(`unsupported platform: ${platform}`);
  }

  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  validateMergeSource(manifest, version, platform);
  manifest.pub_date = new Date().toISOString();
  manifest.platforms[platform] = {
    signature: readSignature(required(values, "signature-file")),
    url: required(values, "url"),
  };
  validateManifest(manifest, version);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`merged ${platform} into ${output} for ${version}\n`);
} else if (command === "verify") {
  const file = required(values, "manifest");
  const version = required(values, "version");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  validateManifest(manifest, version);
  process.stdout.write(
    `verified ${file}: ${version}, ${PLATFORM_KEYS.join(", ")}\n`,
  );
} else {
  fail("expected command: create, merge, or verify");
}
