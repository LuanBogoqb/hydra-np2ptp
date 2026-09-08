import { describe, it } from "node:test";
import assert from "node:assert";
import { isSafeExternalUrl } from "./open-external-safe.ts";

describe("isSafeExternalUrl", () => {
  const cases: Array<[string, string, boolean]> = [
    ["https url with path", "https://example.com/page", true],
    ["plain http url", "http://example.com", true],
    ["file scheme", "file:///C:/Windows/System32/calc.exe", false],
    ["smb scheme", "smb://server/share", false],
    ["search-ms scheme", "search-ms:query=x", false],
    ["ms-msdt scheme", "ms-msdt:id", false],
    ["javascript scheme", "javascript:alert(1)", false],
    ["data scheme", "data:text/html,x", false],
    ["userinfo in authority", "https://user:pass@example.com", false],
    ["percent-encoded userinfo", "https://%6a%61vascript@example.com/", false],
    ["no host", "https://", false],
    ["over length cap", `https://example.com/${"a".repeat(3000)}`, false],
    ["not a url", "not a url", false],
  ];

  for (const [name, url, expected] of cases) {
    it(`${expected ? "accepts" : "rejects"} ${name}`, () => {
      assert.strictEqual(isSafeExternalUrl(url), expected);
    });
  }
});
