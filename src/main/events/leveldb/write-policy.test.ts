import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertWritable,
  isValidSublevelName,
  SUBLEVEL_NAME_PATTERN,
  WRITER_POLICY,
  type LeveldbWriteOp,
} from "./write-policy.ts";

// Game-shaped value the two "games" writers produce: the record read back
// from the db spread with one field overridden. Includes executablePath on
// purpose — the modals write it back as part of the record.
const gameRecord = {
  title: "Some Game",
  objectId: "1245620",
  shop: "steam",
  remoteId: null,
  isDeleted: false,
  playTimeInMilliseconds: 0,
  lastTimePlayed: null,
  iconUrl: null,
  libraryHeroImageUrl: null,
  logoImageUrl: null,
  executablePath: "C:/Games/SomeGame/game.exe",
  executablePathUpdatedAt: "2026-01-01T00:00:00.000Z",
  launchOptions: null,
  favorite: false,
  newDownloadOptionsCount: undefined,
};

describe("WRITER_POLICY", () => {
  it("is fail-closed: only themes and games are writable", () => {
    assert.deepEqual(Object.keys(WRITER_POLICY.sublevels).sort(), [
      "games",
      "themes",
    ]);
  });

  it("root db only allows put and del", () => {
    assert.deepEqual(Object.keys(WRITER_POLICY.root).sort(), ["del", "put"]);
  });

  it("themes allows put, del and clear with any key", () => {
    assert.deepEqual(WRITER_POLICY.sublevels.themes, {
      put: { key: "any" },
      del: { key: "any" },
      clear: true,
    });
  });

  it("games only allows put, field-checked", () => {
    assert.deepEqual(Object.keys(WRITER_POLICY.sublevels.games), ["put"]);
    assert.equal(WRITER_POLICY.sublevels.games.put?.key, "any");
    const fields = WRITER_POLICY.sublevels.games.put?.fields ?? [];
    for (const required of [
      "title",
      "objectId",
      "shop",
      "executablePath",
      "launchOptions",
      "newDownloadOptionsCount",
    ]) {
      assert.ok(fields.includes(required), `missing field ${required}`);
    }
  });
});

describe("isValidSublevelName", () => {
  const cases: Array<[string, string, boolean]> = [
    ["themes", "themes", true],
    ["games", "games", true],
    ["cloud save cache", "cloud-save-local-hash-cache", true],
    ["ps2 memory card saves", "ps2MemoryCardSaves", true],
    ["dot separated", "download.sources.v2", true],
    ["path traversal", "../x", false],
    ["slash", "a/b", false],
    ["space", "a b", false],
    ["empty", "", false],
  ];

  for (const [name, sublevel, expected] of cases) {
    it(`${expected ? "accepts" : "rejects"} ${name}`, () => {
      assert.equal(isValidSublevelName(sublevel), expected);
      assert.equal(SUBLEVEL_NAME_PATTERN.test(sublevel), expected);
    });
  }
});

describe("assertWritable", () => {
  type Case = [
    name: string,
    op: LeveldbWriteOp,
    sublevel: string | null,
    key: string | undefined,
    value: unknown,
    allowed: boolean,
  ];

  const cases: Case[] = [
    // themes: any key
    [
      "themes put",
      "put",
      "themes",
      "any-theme-id",
      { id: "any-theme-id", name: "theme" },
      true,
    ],
    ["themes del", "del", "themes", "any-theme-id", undefined, true],
    ["themes clear", "clear", "themes", undefined, undefined, true],
    // games: whole Game record writes, including executablePath
    [
      "games put of a Game record",
      "put",
      "games",
      "steam:1245620",
      gameRecord,
      true,
    ],
    [
      "games put clearing newDownloadOptionsCount (repacks modal)",
      "put",
      "games",
      "steam:1245620",
      { ...gameRecord, newDownloadOptionsCount: undefined },
      true,
    ],
    [
      "games put clearing launchOptions (game options modal)",
      "put",
      "games",
      "steam:1245620",
      { ...gameRecord, launchOptions: null },
      true,
    ],
    // games: del and clear are main-process only
    ["games del", "del", "games", "steam:1245620", undefined, false],
    ["games clear", "clear", "games", undefined, undefined, false],
    // games: foreign keys in the value
    [
      "games put with a foreign field",
      "put",
      "games",
      "steam:1245620",
      { ...gameRecord, isPinnedByEvil: true },
      false,
    ],
    [
      "games put that only sets a field outside the record shape",
      "put",
      "games",
      "steam:1245620",
      { shimCache: "C:/evil.exe" },
      false,
    ],
    [
      "games put of a non-object value",
      "put",
      "games",
      "steam:1245620",
      "C:/evil.exe",
      false,
    ],
    // root db: search history only
    [
      "root put of the search history key",
      "put",
      null,
      "searchHistory",
      ["query"],
      true,
    ],
    [
      "root del of the search history key",
      "del",
      null,
      "searchHistory",
      undefined,
      true,
    ],
    ["root put of another key", "put", null, "userPreferences", {}, false],
    [
      "root del of another key",
      "del",
      null,
      "userPreferences",
      undefined,
      false,
    ],
    ["root clear", "clear", null, undefined, undefined, false],
    // every other sublevel: no renderer writes
    ["downloads put", "put", "downloads", "steam:1245620", {}, false],
    ["downloads del", "del", "downloads", "steam:1245620", undefined, false],
    ["downloads clear", "clear", "downloads", undefined, undefined, false],
    [
      "userPreferences put",
      "put",
      "userPreferences",
      "userPreferences",
      {},
      false,
    ],
    ["emulators put", "put", "emulators", "rpcs3", {}, false],
    ["downloadSources put", "put", "downloadSources", "source-id", {}, false],
    [
      "ps2 memory card saves put",
      "put",
      "ps2MemoryCardSaves",
      "card::slot1",
      {},
      false,
    ],
    ["unknown sublevel put", "put", "madeUpSublevel", "k", {}, false],
    // path-ish names are refused before any policy lookup
    ["path traversal name", "put", "../x", "k", {}, false],
    ["name with a space", "clear", "a b", undefined, undefined, false],
  ];

  for (const [name, op, sublevel, key, value, allowed] of cases) {
    it(`${allowed ? "allows" : "refuses"} ${name}`, () => {
      if (allowed) {
        assert.doesNotThrow(() => assertWritable(op, sublevel, key, value));
      } else {
        assert.throws(() => assertWritable(op, sublevel, key, value), {
          name: "Error",
        });
      }
    });
  }

  it("refusal messages say what was refused", () => {
    assert.throws(
      () => assertWritable("put", "downloads", "steam:1245620", {}),
      /Leveldb write refused: .*"downloads".*not writable/
    );
    assert.throws(
      () => assertWritable("put", "games", "steam:1245620", { nope: 1 }),
      /nope/
    );
    assert.throws(
      () => assertWritable("put", null, "userPreferences", {}),
      /userPreferences/
    );
  });
});
