import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveLocalUrl } from "./local-protocol.ts";

// Everything runs in its own tmp tree; the real userData is never touched.
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "local-protocol-"));

const rootDir = path.join(tmpBase, "root", "artwork");
const subDir = path.join(rootDir, "sub");
const insideFile = path.join(subDir, "cover.webp");
const outsideDir = path.join(tmpBase, "outside");
const outsideFile = path.join(outsideDir, "secret.txt");

fs.mkdirSync(subDir, { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });
fs.writeFileSync(insideFile, "webp");
fs.writeFileSync(outsideFile, "secret");

// Declare the root the way the app would, already realpathed so the tree is
// stable even if the platform tmp dir sits behind a symlink or an 8.3 short
// name (async realpath is what the helper uses, so expectations must match).
let realRootDir = rootDir;
let realInsideFile = insideFile;
let realOutsideFile = outsideFile;
let options = { roots: [rootDir] };

before(async () => {
  [realRootDir, realInsideFile, realOutsideFile] = await Promise.all([
    fs.promises.realpath(rootDir),
    fs.promises.realpath(insideFile),
    fs.promises.realpath(outsideFile),
  ]);
  options = { roots: [realRootDir] };
});

const lowercaseDrive = (value: string): string =>
  process.platform === "win32"
    ? value.replace(/^([A-Za-z]:)/, (drive) => drive.toLowerCase())
    : value;

const swapCase = (value: string): string =>
  value
    .split("")
    .map((char) =>
      char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()
    )
    .join("");

// Case folding only means something on Windows.
const itOnWindows = process.platform === "win32" ? it : it.skip;

after(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("resolveLocalUrl", () => {
  it("serves a file inside a root", async () => {
    const result = await resolveLocalUrl(`local:${insideFile}`, options);
    assert.strictEqual(result, realInsideFile);
  });

  itOnWindows(
    "serves a file when only the drive letter case differs",
    async () => {
      const result = await resolveLocalUrl(
        `local:${lowercaseDrive(insideFile)}`,
        options
      );
      assert.strictEqual(result, realInsideFile);
    }
  );

  itOnWindows(
    "serves a file when the whole path case differs (Windows is case-insensitive)",
    async () => {
      const result = await resolveLocalUrl(
        `local:${swapCase(insideFile)}`,
        options
      );
      assert.strictEqual(result, realInsideFile);
    }
  );

  it("rejects .. traversal past the root", async () => {
    const traversing = path.join(rootDir, "..", "outside", "secret.txt");
    const result = await resolveLocalUrl(`local:${traversing}`, options);
    assert.strictEqual(result, null);
  });

  it("rejects %2e%2e traversal past the root", async () => {
    const traversing = `${rootDir}/%2e%2e/outside/secret.txt`;
    const result = await resolveLocalUrl(`local:${traversing}`, options);
    assert.strictEqual(result, null);
  });

  it("rejects ..%2F..%2F traversal (stays encoded, resolves to nothing)", async () => {
    const traversing = `${rootDir}/..%2F..%2Fsecret.txt`;
    const result = await resolveLocalUrl(`local:${traversing}`, options);
    assert.strictEqual(result, null);
  });

  it("rejects an absolute path outside all roots", async () => {
    const result = await resolveLocalUrl(`local:${outsideFile}`, options);
    assert.strictEqual(result, null);
  });

  it("rejects an authority-slashed URL outside all roots", async () => {
    const result = await resolveLocalUrl(`local:///${outsideFile}`, options);
    assert.strictEqual(result, null);
  });

  it("rejects a missing file inside a root", async () => {
    const result = await resolveLocalUrl(
      `local:${path.join(rootDir, "nope.webp")}`,
      options
    );
    assert.strictEqual(result, null);
  });

  it("rejects a malformed percent-escape", async () => {
    const result = await resolveLocalUrl(`local:${rootDir}/%zz.webp`, options);
    assert.strictEqual(result, null);
  });

  it("rejects a URL without the local: scheme", async () => {
    const result = await resolveLocalUrl(`file://${outsideFile}`, options);
    assert.strictEqual(result, null);
  });

  it("rejects a symlink from inside the root pointing outside", async () => {
    if (process.platform === "win32") {
      // Junctions need no privilege; point one at the outside dir.
      const junction = path.join(rootDir, "junction");
      fs.symlinkSync(outsideDir, junction, "junction");
      const result = await resolveLocalUrl(
        `local:${path.join(junction, "secret.txt")}`,
        options
      );
      assert.strictEqual(result, null);
      return;
    }

    const link = path.join(rootDir, "link.txt");
    fs.symlinkSync(outsideFile, link);
    const result = await resolveLocalUrl(`local:${link}`, options);
    assert.strictEqual(result, null);
  });

  it("honours an injected realpath seam", async () => {
    // The seam stands in for the filesystem realpath and is consulted for
    // both the requested file and the roots: it may rescue an odd URL into a
    // real inside file, but must leave paths it does not know alone.
    const virtualPath = path.resolve("virtual/cover.webp");
    const seam = async (value: string) =>
      value === virtualPath ? realInsideFile : value;

    const rescued = await resolveLocalUrl("local:virtual/cover.webp", {
      roots: [realRootDir],
      realpath: seam,
    });
    assert.strictEqual(rescued, realInsideFile);

    // ...and can never move a file across the root boundary.
    const escaped = await resolveLocalUrl(`local:${insideFile}`, {
      roots: [realRootDir],
      realpath: async (value) =>
        path.resolve(value) === path.resolve(insideFile)
          ? realOutsideFile
          : value,
    });
    assert.strictEqual(escaped, null);
  });

  it("serves a file named with a leading .. inside a root", async () => {
    const dottedName = path.join(rootDir, "...cache.webp");
    fs.writeFileSync(dottedName, "webp");
    const result = await resolveLocalUrl(`local:${dottedName}`, options);
    assert.strictEqual(result, await fs.promises.realpath(dottedName));
  });

  it("accepts a root given with a trailing separator", async () => {
    const result = await resolveLocalUrl(`local:${insideFile}`, {
      roots: [realRootDir + path.sep],
    });
    assert.strictEqual(result, realInsideFile);
  });

  itOnWindows("accepts a root given with different casing", async () => {
    const result = await resolveLocalUrl(`local:${insideFile}`, {
      roots: [swapCase(realRootDir)],
    });
    assert.strictEqual(result, realInsideFile);
  });

  it("realpaths the roots before containment (8.3/junction relocation)", async () => {
    // Same divergence the production wiring hits on Windows: the root is
    // handed out in a form the on-disk name does not match (8.3 short name or
    // junction-relocated userData), while the file side always realpaths to
    // the long form. The seam stands in for the OS expansion of both.
    const shortFormRoot = path.join(tmpBase, "SHORTFO~1", "artwork");
    const seam = async (value: string) => {
      if (path.resolve(value) === path.resolve(shortFormRoot)) {
        return realRootDir;
      }
      if (path.resolve(value) === path.resolve(insideFile)) {
        return realInsideFile;
      }
      return value;
    };

    const result = await resolveLocalUrl(`local:${insideFile}`, {
      roots: [shortFormRoot],
      realpath: seam,
    });
    assert.strictEqual(result, realInsideFile);
  });
});
