import { registerEvent } from "../register-event";
import { levelKeys, downloadsSublevel } from "@main/level";
import { np2ptp } from "@main/services";
import type { GameShop } from "@types";

const toggleNp2ptpSeed = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string,
  enabled: boolean
) => {
  const downloadKey = levelKeys.game(shop, objectId);
  const download = await downloadsSublevel.get(downloadKey);

  if (!download) throw new Error("no download record for this game");
  if (!download.nptpPath && !download.np2ptpUri) {
    throw new Error("game is not converted to np2ptp");
  }

  if (enabled) {
    if (!download.nptpPath) throw new Error("game is not converted to np2ptp");
    await np2ptp.request({ cmd: "provide", nptp: download.nptpPath });
  } else if (download.np2ptpUri) {
    await np2ptp.request({ cmd: "unprovide", root: download.np2ptpUri });
  }

  await downloadsSublevel.put(downloadKey, {
    ...download,
    np2ptpSeed: enabled,
  });
};

registerEvent("toggleNp2ptpSeed", toggleNp2ptpSeed);
