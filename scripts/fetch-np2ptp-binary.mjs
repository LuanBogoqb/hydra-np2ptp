// Seeds np2ptp/ with the np2ptp release binary so electron-builder can package
// it (electron-builder.yml lists np2ptp as an extraResource, and
// getNp2ptpBinaryPath falls back to resources/np2ptp/ in a packaged app).
//
// Run it with the ts-node loader so it can reuse the shipping updater's own
// helpers:
//
//   node --import ./scripts/register-ts-node.mjs scripts/fetch-np2ptp-binary.mjs
//
// Reusing them matters more than convenience here: the pinned minisign key is
// the trust anchor for np2ptp updates, and a second copy of it in CI could
// drift from the one the app enforces at runtime. Same key, same parser, same
// fail-closed rule - a release whose SHA256SUMS is unsigned, signed with
// another key, or inconsistent with the downloaded bytes stops the build.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NP2PTP_LATEST_RELEASE_URL,
  NP2PTP_SUMS_SIG_ASSET,
  NP2PTP_MINISIGN_PUBKEY,
  np2ptpAssetNameForPlatform,
  parseSha256Sums,
  versionFromTag,
} from "../src/main/services/np2ptp/update-helpers.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const SUMS_ASSET = "SHA256SUMS";

const fail = (message) => {
  console.error(`[fetch-np2ptp] ${message}`);
  process.exit(1);
};

const headers = {
  "user-agent": "hydra-np2ptp-ci",
  accept: "application/vnd.github+json",
};

if (process.env.GITHUB_TOKEN) {
  headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

const fetchAsset = async (assets, name) => {
  const asset = assets.find((candidate) => candidate.name === name);

  if (!asset) {
    fail(`release has no asset named ${name}`);
  }

  const response = await fetch(asset.browser_download_url, {
    headers: { "user-agent": headers["user-agent"] },
    redirect: "follow",
  });

  if (!response.ok) {
    fail(`downloading ${name} failed with HTTP ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
};

const release = await fetch(NP2PTP_LATEST_RELEASE_URL, { headers });

if (!release.ok) {
  fail(`release lookup failed with HTTP ${release.status}`);
}

const { tag_name: tag, assets = [] } = await release.json();
const assetName = np2ptpAssetNameForPlatform(process.platform);

console.log(`[fetch-np2ptp] latest release ${tag}, asset ${assetName}`);

const [binary, sums, signature] = await Promise.all([
  fetchAsset(assets, assetName),
  fetchAsset(assets, SUMS_ASSET),
  fetchAsset(assets, NP2PTP_SUMS_SIG_ASSET),
]);

const { verifyMinisign } = require(
  path.join(repoRoot, "hydra-native", "hydra-native.node")
);

if (!verifyMinisign(sums, signature.toString("utf8"), NP2PTP_MINISIGN_PUBKEY)) {
  fail(
    `SHA256SUMS for ${tag} is not signed by the pinned minisign key - refusing to package it`
  );
}

const expected = parseSha256Sums(sums.toString("utf8")).get(assetName);

if (!expected) {
  fail(`SHA256SUMS does not list ${assetName}`);
}

const actual = crypto.createHash("sha256").update(binary).digest("hex");

if (actual !== expected) {
  fail(
    `checksum mismatch for ${assetName}: expected ${expected}, got ${actual}`
  );
}

const outputName = process.platform === "win32" ? "np2ptp.exe" : "np2ptp";
const outputPath = path.join(repoRoot, "np2ptp", outputName);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, binary);

if (process.platform !== "win32") {
  fs.chmodSync(outputPath, 0o755);
}

console.log(
  `[fetch-np2ptp] verified np2ptp ${versionFromTag(tag)} -> ${outputPath} (${binary.length} bytes)`
);
