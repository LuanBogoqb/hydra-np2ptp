import path from "node:path";
import fs from "node:fs";

import { getDownloadsPath } from "../helpers/get-downloads-path";
import { DownloadOrchestrator, logger, np2ptp } from "@main/services";
import { registerEvent } from "../register-event";
import { GameShop } from "@types";
import { downloadsSublevel, gamesSublevel, levelKeys } from "@main/level";

const deleteGameFolder = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
): Promise<void> => {
  const gameKey = levelKeys.game(shop, objectId);
  const download = await downloadsSublevel.get(gameKey);

  if (!download) return;

  // No-copy invariant: stop serving these files BEFORE they are deleted, so
  // the daemon never answers peers with reads from a vanishing folder.
  if (download.np2ptpUri) {
    await np2ptp
      .request(
        { cmd: "unprovide", root: download.np2ptpUri },
        { timeoutMs: 5000 }
      )
      .catch((err) =>
        logger.warn("np2ptp unprovide before delete failed", err)
      );
  }

  const deleteFile = async (filePath: string, isDirectory = false) => {
    if (fs.existsSync(filePath)) {
      await new Promise<void>((resolve, reject) => {
        fs.rm(
          filePath,
          {
            recursive: isDirectory,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
          },
          (error) => {
            if (error) {
              logger.error(error);
              reject();
            }
            resolve();
          }
        );
      });
    }
  };

  if (download.folderName) {
    const folderPath = path.join(
      download.downloadPath ?? (await getDownloadsPath()),
      download.folderName
    );

    const metaPath = `${folderPath}.meta`;

    await deleteFile(folderPath, true);
    await deleteFile(metaPath);
  }

  await downloadsSublevel.del(gameKey);
  await DownloadOrchestrator.syncAfterDownloadRemoved({ shop, objectId });

  const game = await gamesSublevel.get(gameKey);
  if (game) {
    await gamesSublevel.put(gameKey, {
      ...game,
      installerSizeInBytes: null,
      executablePath: null,
      installedSizeInBytes: null,
      automaticCloudSync: false,
    });
  }
};

registerEvent("deleteGameFolder", deleteGameFolder);
