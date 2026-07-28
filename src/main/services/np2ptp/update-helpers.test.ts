import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  np2ptpAssetNameForPlatform,
  parseSha256Sums,
  versionFromTag,
  isNewerVersion,
} from "./update-helpers.ts";

describe("np2ptp update helpers", () => {
  it("picks the platform asset", () => {
    assert.equal(np2ptpAssetNameForPlatform("win32"), "np2ptp-windows-x86_64.exe");
    assert.equal(np2ptpAssetNameForPlatform("linux"), "np2ptp-linux-x86_64");
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const sums = parseSha256Sums(
      "aa".repeat(32) +
        "  np2ptp-linux-x86_64\n" +
        "bb".repeat(32) +
        " *np2ptp-windows-x86_64.exe\n" +
        "garbage line\n"
    );
    assert.equal(sums.get("np2ptp-linux-x86_64"), "aa".repeat(32));
    assert.equal(sums.get("np2ptp-windows-x86_64.exe"), "bb".repeat(32));
    assert.equal(sums.size, 2);
  });

  it("strips the v prefix from tags", () => {
    assert.equal(versionFromTag("v0.1.9"), "0.1.9");
    assert.equal(versionFromTag("0.2.0"), "0.2.0");
  });

  it("compares versions numerically", () => {
    assert.equal(isNewerVersion("0.1.9", "0.1.10"), true);
    assert.equal(isNewerVersion("0.1.10", "0.1.9"), false);
    assert.equal(isNewerVersion("0.1.9", "0.1.9"), false);
    assert.equal(isNewerVersion(null, "0.1.9"), true);
  });
});
