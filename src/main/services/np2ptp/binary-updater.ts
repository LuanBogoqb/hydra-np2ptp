import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { app } from "electron";
import { SystemPath } from "../system-path";
import { logger } from "../logger";
import { NativeAddon } from "../native-addon";
import {
  NP2PTP_LATEST_RELEASE_URL,
  NP2PTP_SUMS_SIG_ASSET,
  NP2PTP_MINISIGN_PUBKEY,
  np2ptpAssetNameForPlatform,
  parseSha256Sums,
  versionFromTag,
  isNewerVersion,
} from "./update-helpers";

const binaryName = process.platform === "win32" ? "np2ptp.exe" : "np2ptp";

export const managedDir = () =>
  path.join(SystemPath.getPath("userData"), "np2ptp-bin");
export const managedBinaryPath = () => path.join(managedDir(), binaryName);
const versionMarkerPath = () => path.join(managedDir(), "version");
const stagedBinaryPath = () => path.join(managedDir(), `staged-${binaryName}`);
const stagedVersionPath = () => path.join(managedDir(), "staged-version");
const oldBinaryPath = () => path.join(managedDir(), `old-${binaryName}`);

function currentManagedVersion(): string | null {
  try {
    return fs.readFileSync(versionMarkerPath(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Copies the bundled binary into the managed dir on first run. */
export function seedManagedBinaryFromResources(): void {
  if (fs.existsSync(managedBinaryPath())) return;
  if (!app.isPackaged) return;
  const bundled = path.join(process.resourcesPath, "np2ptp", binaryName);
  if (!fs.existsSync(bundled)) return;
  fs.mkdirSync(managedDir(), { recursive: true });
  fs.copyFileSync(bundled, managedBinaryPath());
  // Bundled version is unknown at runtime; no marker means the next update
  // check treats it as outdated and replaces it with a verified download.
  logger.log("np2ptp updater: seeded managed binary from resources");
}

/**
 * A running executable cannot be overwritten on Windows, so downloads are
 * staged and the swap happens here — at boot, before the daemon spawns.
 */
export function finalizeStagedUpdate(): void {
  try {
    // Leftover from a previous swap; the old binary is no longer running.
    if (fs.existsSync(oldBinaryPath()))
      fs.rmSync(oldBinaryPath(), { force: true });

    if (!fs.existsSync(stagedBinaryPath())) return;
    const stagedVersion = fs.readFileSync(stagedVersionPath(), "utf8").trim();
    if (!stagedVersion) return;

    if (fs.existsSync(managedBinaryPath())) {
      fs.renameSync(managedBinaryPath(), oldBinaryPath());
    }
    fs.renameSync(stagedBinaryPath(), managedBinaryPath());
    fs.writeFileSync(versionMarkerPath(), stagedVersion);
    fs.rmSync(stagedVersionPath(), { force: true });
    logger.log(`np2ptp updater: swapped in v${stagedVersion}`);
  } catch (err) {
    logger.error("np2ptp updater: failed to finalize staged update", err);
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Checks the latest np2ptp release and stages a verified download. Never
 * throws — a failed check keeps the binary that is already there (the fork
 * owns keeping np2ptp current; np2ptp does not update itself by design).
 */
export async function stageLatestNp2ptp(): Promise<void> {
  try {
    const release = await fetchJson(NP2PTP_LATEST_RELEASE_URL);
    const tag = typeof release.tag_name === "string" ? release.tag_name : null;
    if (!tag) return;
    const latest = versionFromTag(tag);
    if (!isNewerVersion(currentManagedVersion(), latest)) return;

    const assets = Array.isArray(release.assets) ? release.assets : [];
    const wantedName = np2ptpAssetNameForPlatform(process.platform);
    const findUrl = (name: string): string | null => {
      for (const asset of assets) {
        if (
          asset &&
          typeof asset === "object" &&
          (asset as Record<string, unknown>).name === name &&
          typeof (asset as Record<string, unknown>).browser_download_url ===
            "string"
        ) {
          return (asset as Record<string, unknown>)
            .browser_download_url as string;
        }
      }
      return null;
    };

    const binaryUrl = findUrl(wantedName);
    const sumsUrl = findUrl("SHA256SUMS");
    const sumsSigUrl = findUrl(NP2PTP_SUMS_SIG_ASSET);
    if (!binaryUrl || !sumsUrl) {
      logger.warn(
        `np2ptp updater: release ${tag} missing ${wantedName} or SHA256SUMS`
      );
      return;
    }
    if (!sumsSigUrl) {
      // Fail-closed: an unsigned release is indistinguishable from a
      // compromised release channel. Keep the binary we already trust.
      logger.error(
        `np2ptp updater: release ${tag} has no ${NP2PTP_SUMS_SIG_ASSET} — refusing update`
      );
      return;
    }

    const sumsResponse = await fetch(sumsUrl);
    if (!sumsResponse.ok) throw new Error(`SHA256SUMS ${sumsResponse.status}`);
    const sumsText = await sumsResponse.text();

    const sigResponse = await fetch(sumsSigUrl);
    if (!sigResponse.ok)
      throw new Error(`${NP2PTP_SUMS_SIG_ASSET} ${sigResponse.status}`);
    const sigText = await sigResponse.text();

    if (
      !NativeAddon.verifyMinisign(
        Buffer.from(sumsText, "utf8"),
        sigText,
        NP2PTP_MINISIGN_PUBKEY
      )
    ) {
      logger.error(
        `np2ptp updater: SHA256SUMS signature verification FAILED for ${tag} — refusing update`
      );
      return;
    }

    const expected = parseSha256Sums(sumsText).get(wantedName);
    if (!expected) {
      logger.warn(`np2ptp updater: SHA256SUMS has no entry for ${wantedName}`);
      return;
    }

    const binResponse = await fetch(binaryUrl);
    if (!binResponse.ok) throw new Error(`asset ${binResponse.status}`);
    const bytes = Buffer.from(await binResponse.arrayBuffer());

    const actual = crypto.createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      // Refuse, delete nothing durable, keep the binary that is already there.
      logger.error(
        `np2ptp updater: checksum mismatch for ${wantedName} (${tag}) — refusing update`
      );
      return;
    }

    fs.mkdirSync(managedDir(), { recursive: true });
    fs.writeFileSync(stagedBinaryPath(), bytes);
    if (process.platform !== "win32") {
      fs.chmodSync(stagedBinaryPath(), 0o755);
    }
    fs.writeFileSync(stagedVersionPath(), latest);
    logger.log(
      `np2ptp updater: staged v${latest}, swap happens on next launch`
    );
  } catch (err) {
    logger.warn("np2ptp updater: check failed, keeping current binary", err);
  }
}
