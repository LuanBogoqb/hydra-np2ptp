// Pure helpers for the np2ptp binary updater. Self-contained on purpose: the
// repo's test runner cannot load modules with relative value imports, so
// everything unit-testable lives here, import-free.

export const NP2PTP_LATEST_RELEASE_URL =
  "https://api.github.com/repos/LuanBogoqb/np2ptp/releases/latest";

export function np2ptpAssetNameForPlatform(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? "np2ptp-windows-x86_64.exe"
    : "np2ptp-linux-x86_64";
}

/** `sha256sum` output: one `<hex><spaces><name>` per line ("*name" for binary mode). */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

export function versionFromTag(tag: string): string {
  return tag.replace(/^[vV]/, "");
}

export function isNewerVersion(
  current: string | null,
  latest: string
): boolean {
  if (!current) return true;
  if (current === latest) return false;
  const a = current.split(".").map(Number);
  const b = latest.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return current !== latest;
    if (x !== y) return y > x;
  }
  return false;
}
