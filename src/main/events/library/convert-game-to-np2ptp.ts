import path from "node:path";
import { registerEvent } from "../register-event";
import { levelKeys, downloadsSublevel } from "@main/level";
import { np2ptp, np2ptpStorePath } from "@main/services";
import type { GameShop } from "@types";

export const convertDownloadToNp2ptp = async (
  shop: GameShop,
  objectId: string
): Promise<{ uri: string; verified: boolean }> => {
  const downloadKey = levelKeys.game(shop, objectId);
  const download = await downloadsSublevel.get(downloadKey);

  if (!download) throw new Error("no download record for this game");

  // Without a per-game folder the only alternative is the shared downloads
  // root — converting that would publish every other game in it.
  if (!download.folderName) {
    throw new Error("download has no folder to convert");
  }

  const dataPath = path.join(download.downloadPath, download.folderName);

  // Always the unverified pack path: a verified bridge needs the original
  // .torrent from a trusted location, and download.uri comes from remote
  // sources — treating it as a local file path would let a hostile source
  // point the converter at arbitrary files.
  const result = await np2ptp.request(
    { cmd: "convert", path: dataPath },
    { timeoutMs: 30 * 60_000 }
  );

  if (typeof result.root !== "string") {
    throw new Error("np2ptp convert returned no root");
  }
  const root = result.root;
  const nptpPath = path.join(
    np2ptpStorePath(),
    "manifests",
    `${root.replace(/^np2ptp:/, "")}.nptp`
  );

  await downloadsSublevel.put(downloadKey, {
    ...download,
    np2ptpUri: root,
    nptpPath,
  });

  return { uri: root, verified: false };
};

const convertGameToNp2ptp = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
) => convertDownloadToNp2ptp(shop, objectId);

registerEvent("convertGameToNp2ptp", convertGameToNp2ptp);
