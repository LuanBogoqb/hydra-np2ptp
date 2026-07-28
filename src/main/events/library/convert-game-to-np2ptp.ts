import path from "node:path";
import fs from "node:fs";
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

  const dataPath = download.folderName
    ? path.join(download.downloadPath, download.folderName)
    : download.downloadPath;

  // A verified (piece-hash checked) conversion needs the original .torrent
  // file on disk; magnets and direct downloads convert as-is, unverified.
  const localTorrent =
    download.uri.endsWith(".torrent") && fs.existsSync(download.uri)
      ? download.uri
      : null;

  const payload = localTorrent
    ? { cmd: "convert", torrent: localTorrent, data: dataPath }
    : { cmd: "convert", path: dataPath };

  const result = await np2ptp.request(payload, { timeoutMs: 30 * 60_000 });

  const root = result.root as string;
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

  return { uri: root, verified: localTorrent !== null };
};

const convertGameToNp2ptp = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
) => convertDownloadToNp2ptp(shop, objectId);

registerEvent("convertGameToNp2ptp", convertGameToNp2ptp);
