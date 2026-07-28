import { downloadsSublevel } from "./level/sublevels/downloads";
import { orderBy } from "lodash-es";
import { Downloader } from "@shared";
import { levelKeys, db } from "./level";
import { refreshGlobalTrackersUrlCache } from "@main/helpers";
import { type Download, type UserPreferences } from "../types";
import path from "node:path";
import fs from "node:fs";
import {
  SystemPath,
  CommonRedistManager,
  TorBoxClient,
  RealDebridClient,
  PremiumizeClient,
  AllDebridClient,
  DownloadManager,
  HydraApi,
  uploadGamesBatch,
  startMainLoop,
  Ludusavi,
  Lock,
  DeckyPlugin,
  DownloadSourcesChecker,
  DownloadOrchestrator,
  SSEClient,
  Wine,
  WindowManager,
  logger,
  np2ptp,
  isNp2ptpAvailable,
  reprovideAllFromDb,
  seedManagedBinaryFromResources,
  finalizeStagedUpdate,
  stageLatestNp2ptp,
} from "@main/services";
import { migrateDownloadSources } from "./helpers/migrate-download-sources";
import { getDirSize } from "./services/download/helpers";
import { GofileApi } from "./services/hosters";
import { clearLegacyAchievementPersistence } from "./level/clear-legacy-achievements";

const hasMissingSeedFiles = async (download: Download): Promise<boolean> => {
  if (!download.folderName) return false;

  const downloadTargetPath = path.join(
    download.downloadPath,
    download.folderName
  );

  if (!fs.existsSync(downloadTargetPath)) {
    return true;
  }

  const expectedSize = download.selectedFilesSize ?? download.fileSize ?? 0;

  if (expectedSize <= 0) {
    return false;
  }

  const currentSize = await getDirSize(downloadTargetPath);
  return currentSize < expectedSize;
};

export const loadState = async () => {
  await Lock.acquireLock();
  await clearLegacyAchievementPersistence();

  const userPreferences = await db.get<string, UserPreferences | null>(
    levelKeys.userPreferences,
    {
      valueEncoding: "json",
    }
  );

  Wine.syncUserPreferences(userPreferences);

  await import("./events");

  if (userPreferences?.realDebridApiToken) {
    RealDebridClient.authorize(userPreferences.realDebridApiToken);
  }

  if (userPreferences?.premiumizeApiToken) {
    PremiumizeClient.authorize(userPreferences.premiumizeApiToken);
  }

  if (userPreferences?.allDebridApiToken) {
    AllDebridClient.authorize(userPreferences.allDebridApiToken);
  }

  if (userPreferences?.torBoxApiToken) {
    TorBoxClient.authorize(userPreferences.torBoxApiToken);
  }

  GofileApi.initialize();

  if (
    userPreferences?.appendGlobalTrackersUrl &&
    userPreferences?.globalTrackersUrl
  ) {
    refreshGlobalTrackersUrlCache().catch((err) =>
      logger.warn("Failed to refresh global tracker URL cache on startup", err)
    );
  }

  Ludusavi.copyConfigFileToUserData();
  Ludusavi.copyBinaryToUserData();

  if (process.platform === "linux") {
    DeckyPlugin.checkAndUpdateIfOutdated();
  }

  await HydraApi.setupApi().then(async () => {
    uploadGamesBatch();
    void migrateDownloadSources();

    const { syncDownloadSourcesFromApi } = await import("./services/user");
    void syncDownloadSourcesFromApi();

    // Check for new download options on startup (if enabled)
    (async () => {
      await DownloadSourcesChecker.checkForChanges();
    })();

    if (HydraApi.isLoggedIn()) {
      SSEClient.connect();
    }
  });

  const downloadToResume =
    await DownloadOrchestrator.bootstrapDownloadsOnStartup();
  const normalizedDownloads = await downloadsSublevel
    .values()
    .all()
    .then((games) => orderBy(games, "timestamp", "desc"));

  const downloadsToSeed: Download[] = [];

  for (const game of normalizedDownloads) {
    if (
      !game.shouldSeed ||
      game.downloader !== Downloader.Torrent ||
      game.progress !== 1 ||
      game.status !== "seeding" ||
      game.uri === null
    ) {
      continue;
    }

    if (!(await hasMissingSeedFiles(game))) {
      downloadsToSeed.push(game);
      continue;
    }

    const gameKey = levelKeys.game(game.shop, game.objectId);
    const expectedSize = game.selectedFilesSize ?? game.fileSize ?? 0;
    let progress = game.progress;

    if (game.folderName) {
      const downloadTargetPath = path.join(game.downloadPath, game.folderName);
      const currentSize = fs.existsSync(downloadTargetPath)
        ? await getDirSize(downloadTargetPath)
        : 0;
      progress =
        expectedSize > 0
          ? Math.min(currentSize / expectedSize, 1)
          : game.progress;
    }

    await downloadsSublevel.put(gameKey, {
      ...game,
      status: "paused",
      shouldSeed: false,
      queued: false,
      pinnedToHero: false,
      progress,
    });

    logger.warn(
      `[Startup] Seed files missing for ${gameKey}; seeding was disabled`
    );
  }

  // For torrents use Python RPC; HTTP downloads use JS downloader.
  // A dead Python RPC (missing libtorrent, broken interpreter) must not abort
  // the rest of boot — np2ptp and the UI still work without it.
  try {
    const isTorrent = downloadToResume?.downloader === Downloader.Torrent;
    if (downloadToResume && !isTorrent) {
      // Start Python RPC for seeding only, then resume HTTP download with JS
      await DownloadManager.startRPC(undefined, downloadsToSeed);
      await DownloadManager.startDownload(downloadToResume).catch((err) => {
        // If resume fails, just log it - user can manually retry
        logger.error("Failed to auto-resume download:", err);
      });
    } else {
      // Use Python RPC for everything (torrent or fallback)
      await DownloadManager.startRPC(
        downloadToResume ?? undefined,
        downloadsToSeed
      );
    }
  } catch (err) {
    logger.error("Python RPC bootstrap failed; torrent engine unavailable", err);
  }

  WindowManager.sendDownloadsUpdated();

  startMainLoop();

  // Binary upkeep is the fork's job (np2ptp never updates itself): finalize a
  // previously staged download BEFORE the daemon spawns, then check for a new
  // release in the background — silent, gated on the auto-update preference.
  seedManagedBinaryFromResources();
  finalizeStagedUpdate();
  db.get<string, UserPreferences | null>(levelKeys.userPreferences, {
    valueEncoding: "json",
  })
    .then((preferences) => {
      if (preferences?.np2ptpAutoUpdate ?? true) {
        return stageLatestNp2ptp();
      }
      return undefined;
    })
    .catch((err) => logger.warn("np2ptp update check failed", err));

  if (isNp2ptpAvailable()) {
    np2ptp
      .ensureReady()
      .then((ready) => {
        logger.info(
          `np2ptp daemon ready (v${ready.version}, peer ${ready.peer_id})`
        );
        return reprovideAllFromDb();
      })
      .catch((err) => logger.error("np2ptp bootstrap failed", err));
  } else {
    logger.warn(
      "np2ptp binary not found; np2ptp features disabled (set NP2PTP_BIN in dev)"
    );
  }

  if (process.platform === "win32") {
    CommonRedistManager.downloadCommonRedist();
  }

  SystemPath.checkIfPathsAreAvailable();
};
