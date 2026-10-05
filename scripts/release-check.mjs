#!/usr/bin/env node
// Checks that a release tag matches the version in every manifest, then
// prints that version's CHANGELOG section plus a downloads footer, for use
// as the GitHub release notes. Run as `node scripts/release-check.mjs v0.3.0`.
// Cargo.lock isn't checked: `cargo build --locked` fails if it disagrees.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const tag = process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error("usage: node scripts/release-check.mjs vX.Y.Z");
  process.exit(1);
}
const version = tag.slice(1);

// The first `version = "…"` line in a Cargo.toml is the [package] version,
// since [package] comes first and dependencies use inline tables.
function cargoVersion(path) {
  return read(path).match(/^version\s*=\s*"([^"]+)"/m)?.[1];
}

const found = {
  "package.json": JSON.parse(read("package.json")).version,
  "src-tauri/Cargo.toml": cargoVersion("src-tauri/Cargo.toml"),
  "ebook_research_core/Cargo.toml": cargoVersion(
    "ebook_research_core/Cargo.toml",
  ),
};
const mismatches = Object.entries(found).filter(([, v]) => v !== version);
if (mismatches.length > 0) {
  for (const [file, v] of mismatches) {
    console.error(`version mismatch: tag ${tag}, ${file} ${v}`);
  }
  process.exit(1);
}

const escaped = version.replaceAll(".", "\\.");
const changelog = read("CHANGELOG.md");
const heading = new RegExp(`^## \\[${escaped}\\][^\\n]*\\n`, "m").exec(
  changelog,
);
let notes = "";
if (heading) {
  const rest = changelog.slice(heading.index + heading[0].length);
  const next = rest.search(/^## \[/m);
  notes = (next === -1 ? rest : rest.slice(0, next)).trim();
}
if (!notes) {
  console.error(`CHANGELOG.md has no notes for ${version}`);
  process.exit(1);
}

const footer = `**Downloads**: Windows: \`Pitaka_${version}_x64-setup.exe\`. Linux: the \`.AppImage\`, or the \`.deb\`/\`.rpm\` for your distro. The Windows installers aren't code-signed yet, so Windows SmartScreen will warn before running them; choose More info → Run anyway. \`SHA256SUMS\` lists each file's checksum.`;

console.log(`${notes}\n\n${footer}`);
