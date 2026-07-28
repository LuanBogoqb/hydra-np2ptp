import path from "node:path";
import fs from "node:fs";
import { app } from "electron";

const binaryName = process.platform === "win32" ? "np2ptp.exe" : "np2ptp";

/**
 * Resolution order:
 * 1. NP2PTP_BIN environment override (dev runs point this at a local build)
 * 2. packaged binary under resources/np2ptp/
 *
 * Returns null when no binary can be found — np2ptp features stay disabled
 * and surface a clear error instead of crashing the app.
 */
export function getNp2ptpBinaryPath(): string | null {
  const fromEnv = process.env.NP2PTP_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, "np2ptp", binaryName);
    if (fs.existsSync(packaged)) return packaged;
  }

  return null;
}
