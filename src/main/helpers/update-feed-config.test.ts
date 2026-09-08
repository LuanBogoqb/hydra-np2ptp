import { describe, it } from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findSetFeedUrlOverrides,
  readPublishTarget,
} from "./update-feed-config.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
);

const FORK_PUBLISH_TARGET = { owner: "LuanBogoqb", repo: "hydra-np2ptp" };

const listMainTsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory()
      ? listMainTsFiles(full)
      : entry.name.endsWith(".ts")
        ? [full]
        : [];
  });

describe("readPublishTarget", () => {
  it("parses owner and repo from a publish block", () => {
    assert.deepStrictEqual(
      readPublishTarget(
        [
          "appId: gg.hydralauncher.hydra",
          "publish:",
          "  provider: github",
          "  owner: LuanBogoqb",
          "  repo: hydra-np2ptp",
        ].join("\n")
      ),
      { owner: "LuanBogoqb", repo: "hydra-np2ptp" }
    );
  });

  it("returns null when there is no publish block", () => {
    assert.strictEqual(
      readPublishTarget("appId: abc\nwin:\n  target: nsis"),
      null
    );
  });

  it("returns null when the block lacks owner or repo", () => {
    assert.strictEqual(
      readPublishTarget("publish:\n  provider: github\n  owner: someone"),
      null
    );
  });

  it("stops at the next top-level key", () => {
    assert.deepStrictEqual(
      readPublishTarget(
        [
          "publish:",
          "  provider: github",
          "  owner: a",
          "  repo: b",
          "npmRebuild: false",
        ].join("\n")
      ),
      { owner: "a", repo: "b" }
    );
  });
});

describe("findSetFeedUrlOverrides", () => {
  it("finds a multiline github override", () => {
    assert.deepStrictEqual(
      findSetFeedUrlOverrides(
        [
          "const { autoUpdater } = updater;",
          "autoUpdater.setFeedURL({",
          '  provider: "github",',
          '  owner: "hydralauncher",',
          '  repo: "hydra",',
          "});",
        ].join("\n")
      ),
      [{ owner: "hydralauncher", repo: "hydra" }]
    );
  });

  it("returns an empty array when no override exists", () => {
    assert.deepStrictEqual(
      findSetFeedUrlOverrides("autoUpdater.logger = logger;"),
      []
    );
  });
});

describe("drift: repo updater feed stays on the fork", () => {
  it("electron-builder.yml publishes to the fork repo", () => {
    const yml = readFileSync(
      path.join(REPO_ROOT, "electron-builder.yml"),
      "utf-8"
    );
    assert.deepStrictEqual(readPublishTarget(yml), FORK_PUBLISH_TARGET);
  });

  it("no main source overrides the feed away from the fork repo", () => {
    // Test files are skipped: they embed sample overrides as literals.
    const sources = listMainTsFiles(path.join(REPO_ROOT, "src", "main")).filter(
      (file) => !file.endsWith(".test.ts")
    );

    const overrides = sources
      .map((file) => findSetFeedUrlOverrides(readFileSync(file, "utf-8")))
      .flat();

    assert.deepStrictEqual(
      overrides.filter(
        (override) =>
          override.owner !== FORK_PUBLISH_TARGET.owner ||
          override.repo !== FORK_PUBLISH_TARGET.repo
      ),
      []
    );

    // Pins today's state: the builder config is the only feed source.
    assert.deepStrictEqual(overrides, []);
  });
});
