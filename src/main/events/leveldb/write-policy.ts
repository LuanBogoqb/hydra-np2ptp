// Write policy for the renderer leveldb IPC surface (leveldbPut/Del/Clear).
// Evidence-driven and fail-closed: a sublevel that is not listed here, or an
// op that is not listed for a listed sublevel, is refused. Reads are not
// governed by this module — only the three write handlers consult it.
//
// This module must stay free of @main/level and electron imports so the
// colocated test can load it without touching the real database.

export type LeveldbWriteOp = "put" | "del" | "clear";

// Which keys an op may touch: "any" key, or an exact key allowlist.
type KeyRule = "any" | readonly string[];

export interface SublevelOpRule {
  key: KeyRule;
  // put only: the value's own keys must be a subset of this allowlist.
  fields?: readonly string[];
}

export interface SublevelWritePolicy {
  put?: SublevelOpRule;
  del?: SublevelOpRule;
  clear?: true;
}

export interface WriterPolicy {
  // Writes without a sublevel name go to the root db.
  root: SublevelWritePolicy;
  sublevels: Record<string, SublevelWritePolicy>;
}

// The only root-db key the renderer writes is the search history entry
// (src/renderer/src/hooks/use-search-history.ts:10, put at :53 and :63,
// del at :70).
const SEARCH_HISTORY_KEY = "searchHistory";

// Keys of a Game record (src/types/level.types.ts:31). The only renderer
// writes to "games" spread the record they just read back and override one
// field: launchOptions (game-options-modal.tsx:402 and :827) and
// newDownloadOptionsCount (repacks-modal.tsx:132) — both already Game fields.
// executablePath travels inside that spread, so it stays on the allowlist;
// what gets refused is any key that is not part of the record shape.
export const GAME_RECORD_FIELDS = [
  "title",
  "iconUrl",
  "libraryHeroImageUrl",
  "logoImageUrl",
  "customIconUrl",
  "customLogoImageUrl",
  "customHeroImageUrl",
  "customCoverImageUrl",
  "originalIconPath",
  "originalLogoPath",
  "originalHeroPath",
  "customOriginalIconPath",
  "customOriginalLogoPath",
  "customOriginalHeroPath",
  "customOriginalCoverPath",
  "playTimeInMilliseconds",
  "unsyncedDeltaPlayTimeInMilliseconds",
  "lastTimePlayed",
  "addedToLibraryAt",
  "objectId",
  "shop",
  "remoteId",
  "collectionIds",
  "isDeleted",
  "winePrefixPath",
  "protonPath",
  "executablePath",
  "executablePathUpdatedAt",
  "trackingExecutablePaths",
  "trackingExecutablePathsUpdatedAt",
  "launchOptions",
  "autoRunMangohud",
  "autoRunGamemode",
  "favorite",
  "isPinned",
  "achievementCount",
  "unlockedAchievementCount",
  "reportedUnlockedAchievementCount",
  "pinnedDate",
  "automaticCloudSync",
  "hasManuallyUpdatedPlaytime",
  "newDownloadOptionsCount",
  "installedSizeInBytes",
  "installerSizeInBytes",
  "steamShortcutAppId",
  "platform",
  "discs",
  "selectedDiscPath",
  "dontAskDiscSelection",
  "romSizeBytes",
] as const;

// themes: theme import/add/delete/delete-all (import-theme-modal.tsx:49,
// add-theme-modal.tsx:94, delete-theme-modal.tsx:32,
// delete-all-themes-modal.tsx:31) — any key.
// games: the two Game-record writes above, field-checked.
// Every other sublevel (downloads, userPreferences, emulators,
// downloadSources, memory-card saves, ...) is absent on purpose: no renderer
// writes.
export const WRITER_POLICY: WriterPolicy = {
  root: {
    put: { key: [SEARCH_HISTORY_KEY] },
    del: { key: [SEARCH_HISTORY_KEY] },
  },
  sublevels: {
    themes: { put: { key: "any" }, del: { key: "any" }, clear: true },
    games: { put: { key: "any", fields: GAME_RECORD_FIELDS } },
  },
};

// Blocks path-ish sublevel names before they ever reach a sublevel handle.
// Applies to every op, read and write, via getSublevelByName.
export const SUBLEVEL_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export const isValidSublevelName = (sublevelName: string): boolean =>
  SUBLEVEL_NAME_PATTERN.test(sublevelName);

const describeScope = (sublevelName: string | null | undefined): string =>
  sublevelName == null ? "the root db" : `sublevel "${sublevelName}"`;

const refused = (reason: string): never => {
  throw new Error(`Leveldb write refused: ${reason}`);
};

// Throws unless the renderer may perform `op` on this scope. `key` and
// `value` are only needed for put/del. Pure: never touches the database.
export const assertWritable = (
  op: LeveldbWriteOp,
  sublevelName: string | null | undefined,
  key?: string,
  value?: unknown
): void => {
  if (sublevelName != null && !isValidSublevelName(sublevelName)) {
    return refused(
      `${JSON.stringify(sublevelName)} is not a valid sublevel name`
    );
  }

  const policy =
    sublevelName == null
      ? WRITER_POLICY.root
      : WRITER_POLICY.sublevels[sublevelName];

  if (!policy) {
    return refused(
      `${describeScope(sublevelName)} is not writable from the renderer`
    );
  }

  if (op === "clear") {
    if (policy.clear !== true) {
      return refused(
        `clear on ${describeScope(sublevelName)} is not permitted`
      );
    }
    return;
  }

  const rule = policy[op];
  if (!rule) {
    return refused(`${op} on ${describeScope(sublevelName)} is not permitted`);
  }

  if (rule.key !== "any" && (key == null || !rule.key.includes(key))) {
    return refused(
      `${op} of key ${JSON.stringify(key ?? null)} on ${describeScope(
        sublevelName
      )} is not permitted`
    );
  }

  if (op === "put" && rule.fields) {
    const fields = rule.fields;
    if (value === null || typeof value !== "object") {
      return refused(
        `put on ${describeScope(sublevelName)} requires an object value`
      );
    }
    const foreign = Object.keys(value as object).filter(
      (field) => !fields.includes(field)
    );
    if (foreign.length > 0) {
      return refused(
        `put value on ${describeScope(sublevelName)} sets field(s) outside the allowlist: ${foreign.join(", ")}`
      );
    }
  }
};
