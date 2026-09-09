import { describe, it } from "node:test";
import assert from "node:assert";
import { isAllowedOrigin } from "./allowed-origin.ts";

describe("isAllowedOrigin", () => {
  const cases: Array<[string, string, string, boolean]> = [
    [
      "same origin with path",
      "https://example.com/page",
      "https://example.com",
      true,
    ],
    [
      "case-insensitive host",
      "https://EXAMPLE.com/page",
      "https://example.com",
      true,
    ],
    [
      "default port normalized",
      "https://example.com:443/page",
      "https://example.com",
      true,
    ],
    ["other host", "https://evil.com/page", "https://example.com", false],
    [
      "port mismatch",
      "https://example.com:8443/page",
      "https://example.com",
      false,
    ],
    [
      "scheme mismatch",
      "http://example.com/page",
      "https://example.com",
      false,
    ],
    [
      "file scheme",
      "file:///C:/Windows/System32/calc.exe",
      "https://example.com",
      false,
    ],
    ["javascript scheme", "javascript:alert(1)", "https://example.com", false],
    ["data scheme", "data:text/html,x", "https://example.com", false],
    [
      "cyrillic homoglyph host",
      "https://еxample.com",
      "https://example.com",
      false,
    ],
    [
      "punycode lookalike host",
      "https://xn--e1afmkfd.example",
      "https://example.com",
      false,
    ],
    ["about blank", "about:blank", "https://example.com", true],
    [
      "devtools scheme",
      "devtools://devtools/bundled/inspector.html",
      "https://example.com",
      true,
    ],
    [
      "chrome extension scheme",
      "chrome-extension://abcdef/popup.html",
      "https://example.com",
      true,
    ],
    ["unparseable target", "not a url", "https://example.com", false],
    ["unknown current origin", "https://example.com/page", "", false],
  ];

  for (const [name, to, current, expected] of cases) {
    it(`${expected ? "allows" : "denies"} ${name}`, () => {
      assert.strictEqual(isAllowedOrigin(to, current), expected);
    });
  }
});
