import { downloadsSublevel } from "@main/level";
import { logger } from "@main/services";
import { Downloader } from "@shared";

/**
 * Hydra 4.1.0 gave id 14 to the upstream Archive.org downloader, which this
 * fork had already used for np2ptp. The uri scheme — not the stored id — is
 * what actually identifies an np2ptp download, so rows are re-tagged by uri:
 * a legacy 14 with an np2ptp: uri becomes Np2ptp, and every other 14 is a
 * genuine Archive.org download and is left alone.
 */
const LEGACY_NP2PTP_DOWNLOADER_ID = 14;

export const migrateNp2ptpDownloaderId = async () => {
  let migrated = 0;

  for await (const [key, download] of downloadsSublevel.iterator()) {
    if ((download.downloader as number) !== LEGACY_NP2PTP_DOWNLOADER_ID) {
      continue;
    }

    if (!download.uri?.startsWith("np2ptp:")) {
      continue;
    }

    await downloadsSublevel.put(key, {
      ...download,
      downloader: Downloader.Np2ptp,
    });

    migrated += 1;
  }

  if (migrated > 0) {
    logger.info(
      `[np2ptp] Migrated ${migrated} download(s) from legacy downloader id ${LEGACY_NP2PTP_DOWNLOADER_ID}`
    );
  }
};
