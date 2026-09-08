import { shell } from "electron";
import { registerEvent } from "../register-event";
import { logger } from "@main/services";
import { isSafeExternalUrl } from "@main/helpers/open-external-safe";

const openExternal = async (
  _event: Electron.IpcMainInvokeEvent,
  src: string
) => {
  if (!isSafeExternalUrl(src)) {
    logger.warn("Refused to open unsafe external URL:", src);
    return;
  }

  return shell.openExternal(src);
};

registerEvent("openExternal", openExternal);
