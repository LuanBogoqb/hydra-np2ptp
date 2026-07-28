import cp from "node:child_process";
import path from "node:path";
import { SystemPath } from "../system-path";
import { logger } from "../logger";
import { WindowManager } from "../window-manager";
import { downloadsSublevel } from "../../level/sublevels/downloads";
import { getNp2ptpBinaryPath } from "./binary-path";
import { Np2ptpDaemon } from "./np2ptp-daemon";

export { Np2ptpDaemon } from "./np2ptp-daemon";
export { getNp2ptpBinaryPath } from "./binary-path";

export const np2ptpStorePath = () =>
  path.join(SystemPath.getPath("userData"), "np2ptp");

export function isNp2ptpAvailable(): boolean {
  return getNp2ptpBinaryPath() !== null;
}

/**
 * Desired seeding state lives in Hydra's DB; the daemon only executes.
 * Called once after boot and again after every daemon restart.
 */
export async function reprovideAllFromDb(): Promise<void> {
  const downloads = await downloadsSublevel.values().all();
  for (const download of downloads) {
    if (!download.np2ptpSeed || !download.nptpPath) continue;
    try {
      await np2ptp.request({ cmd: "provide", nptp: download.nptpPath });
    } catch (err) {
      logger.warn?.("np2ptp re-provide failed", download.nptpPath, err);
    }
  }
}

export const np2ptp = new Np2ptpDaemon({
  spawnFn: () => {
    const binary = getNp2ptpBinaryPath();
    if (!binary) {
      throw new Error(
        "np2ptp binary not found (set NP2PTP_BIN or install a packaged build)"
      );
    }
    return cp.spawn(binary, ["daemon", "--store", np2ptpStorePath()], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env },
    });
  },
  onWarn: (message) => {
    logger.warn?.("np2ptp daemon warn", message);
    WindowManager.sendToAppWindows?.("on-np2ptp-warn", message);
  },
  onCrash: (attempts) => {
    logger.error?.(`np2ptp daemon gave up after ${attempts} restarts`);
    WindowManager.sendToAppWindows?.("on-np2ptp-crashed");
  },
  onRestart: () => reprovideAllFromDb(),
});
