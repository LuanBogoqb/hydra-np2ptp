// One-time boot normalization for games records, so the renderer leveldb
// write policy (src/main/events/leveldb/write-policy.ts) never refuses a
// record that predates it: installs carry games records with keys upstream
// has since renamed or removed (collectionId, trackingExecutablePath), and
// every spread-based rewrite in the renderer keeps them alive forever.
//
// Pure module: no db, no electron, no runtime imports (the allowlist is
// injected) so the colocated test can load it under the node test runner.
// The db-wired wrapper is normalize-legacy-game-records.ts, mirroring the
// automatic-sync-default-migration pair.
import type { Game } from "@types";

export interface LegacyGameRecordsStore {
  getCompleted: () => Promise<boolean>;
  getGames: () => Promise<[string, Game][]>;
  commit: (normalizedGames: [string, Game][]) => Promise<void>;
}

export interface LegacyGameRecordNormalizationResult {
  ran: boolean;
  touched: number;
}

export interface GameRecordNormalization {
  record: Game;
  changed: boolean;
  dropped: string[];
}

// Drops every key of a games record that is not on the renderer write
// allowlist (GAME_RECORD_FIELDS). Keys are re-emitted in canonical allowlist
// order; the record is returned untouched when there is nothing to drop.
export const normalizeGameRecord = (
  record: Game,
  allowedFields: readonly string[]
): GameRecordNormalization => {
  const source = record as unknown as Record<string, unknown>;
  const dropped = Object.keys(source).filter(
    (field) => !allowedFields.includes(field)
  );

  if (dropped.length === 0) {
    return { record, changed: false, dropped };
  }

  const cleaned: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (Object.hasOwn(source, field)) {
      cleaned[field] = source[field];
    }
  }

  return { record: cleaned as unknown as Game, changed: true, dropped };
};

export const normalizeLegacyGameRecordsWithStore = async (
  store: LegacyGameRecordsStore,
  allowedFields: readonly string[]
): Promise<LegacyGameRecordNormalizationResult> => {
  if (await store.getCompleted()) {
    return { ran: false, touched: 0 };
  }

  const games = await store.getGames();
  const normalized: [string, Game][] = [];
  for (const [key, record] of games) {
    const result = normalizeGameRecord(record, allowedFields);
    if (result.changed) {
      normalized.push([key, result.record]);
    }
  }

  await store.commit(normalized);
  return { ran: true, touched: normalized.length };
};
