import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeGameRecord,
  normalizeLegacyGameRecordsWithStore,
  type LegacyGameRecordsStore,
} from "./normalize-legacy-game-records.policy.ts";
import type { Game } from "@types";
import { GAME_RECORD_FIELDS } from "../events/leveldb/write-policy.ts";

const cleanRecord = {
  title: "Some Game",
  objectId: "1245620",
  shop: "steam",
  remoteId: null,
  isDeleted: false,
  playTimeInMilliseconds: 0,
  lastTimePlayed: null,
  executablePath: "C:/Games/SomeGame/game.exe",
  launchOptions: "-novid",
} as unknown as Game;

// Keys upstream renamed or removed that still exist in real installs.
const legacyKeys = {
  collectionId: "abc",
  trackingExecutablePath: "C:/old.exe",
};

describe("normalizeGameRecord", () => {
  it("keeps a record that already matches the allowlist", () => {
    const result = normalizeGameRecord(cleanRecord, GAME_RECORD_FIELDS);
    assert.equal(result.changed, false);
    assert.equal(result.record, cleanRecord);
    assert.deepEqual(result.dropped, []);
  });

  it("drops legacy renamed fields and keeps the rest", () => {
    const dirty = { ...cleanRecord, ...legacyKeys } as unknown as Game;
    const result = normalizeGameRecord(dirty, GAME_RECORD_FIELDS);

    assert.equal(result.changed, true);
    assert.deepEqual(result.dropped.sort(), [
      "collectionId",
      "trackingExecutablePath",
    ]);
    assert.deepEqual(result.record, cleanRecord);
  });

  it("keeps executablePath across a normalization", () => {
    const dirty = { ...cleanRecord, ...legacyKeys } as unknown as Game;
    const result = normalizeGameRecord(dirty, GAME_RECORD_FIELDS);
    assert.equal(result.record.executablePath, cleanRecord.executablePath);
  });

  it("drops a record that is entirely made of foreign keys", () => {
    const foreign = { collectionId: "abc" } as unknown as Game;
    const result = normalizeGameRecord(foreign, GAME_RECORD_FIELDS);

    assert.equal(result.changed, true);
    assert.deepEqual(result.record, {});
  });
});

describe("normalizeLegacyGameRecordsWithStore", () => {
  const makeStore = (
    records: [string, Game][],
    completed = false
  ): LegacyGameRecordsStore & {
    committed: [string, Game][];
    commitCalls: number;
  } => {
    const store = {
      committed: [] as [string, Game][],
      commitCalls: 0,
      getCompleted: async () => completed,
      getGames: async () => records,
      commit: async (normalizedGames: [string, Game][]) => {
        store.commitCalls += 1;
        store.committed = normalizedGames;
      },
    };
    return store;
  };

  it("normalizes only the dirty records and reports the count", async () => {
    const dirtyA = { ...cleanRecord, collectionId: "abc" } as unknown as Game;
    const dirtyB = {
      ...cleanRecord,
      trackingExecutablePath: "C:/old.exe",
    } as unknown as Game;
    const store = makeStore([
      ["steam:1", cleanRecord],
      ["steam:2", dirtyA],
      ["steam:3", dirtyB],
    ]);

    const result = await normalizeLegacyGameRecordsWithStore(
      store,
      GAME_RECORD_FIELDS
    );

    assert.deepEqual(result, { ran: true, touched: 2 });
    assert.equal(store.commitCalls, 1);
    assert.deepEqual(
      store.committed.map(([key]) => key),
      ["steam:2", "steam:3"]
    );
  });

  it("runs once: a completed marker skips everything", async () => {
    const dirty = { ...cleanRecord, collectionId: "abc" } as unknown as Game;
    const store = makeStore([["steam:1", dirty]], true);

    const result = await normalizeLegacyGameRecordsWithStore(
      store,
      GAME_RECORD_FIELDS
    );

    assert.deepEqual(result, { ran: false, touched: 0 });
    assert.equal(store.commitCalls, 0);
  });

  it("commits nothing when every record is already clean", async () => {
    const store = makeStore([["steam:1", cleanRecord]]);

    const result = await normalizeLegacyGameRecordsWithStore(
      store,
      GAME_RECORD_FIELDS
    );

    assert.deepEqual(result, { ran: true, touched: 0 });
    assert.deepEqual(store.committed, []);
  });
});
