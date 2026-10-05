import { describe, it } from "node:test";
import assert from "node:assert";
import { CONTENT_SECURITY_POLICY, isRendererOrigin } from "./csp.ts";

const directive = (name: string): string =>
  CONTENT_SECURITY_POLICY.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `)) ?? "";

describe("CONTENT_SECURITY_POLICY", () => {
  it("has no wildcard source in default-src", () => {
    assert.ok(!directive("default-src").includes("*"));
  });

  it("has no wildcard source in script-src", () => {
    assert.ok(!directive("script-src").includes("*"));
  });

  it("drops objects and embeds", () => {
    assert.strictEqual(directive("object-src"), "object-src 'none'");
  });

  it("keeps local: and https: image sources for artwork", () => {
    const imgSrc = directive("img-src");

    assert.ok(imgSrc.includes("local:"));
    assert.ok(imgSrc.includes("https:"));
  });

  it("keeps the local app scheme in default-src", () => {
    assert.ok(directive("default-src").includes("local:"));
  });

  it("keeps inline styles for the theme editor custom css", () => {
    assert.ok(directive("style-src").includes("'unsafe-inline'"));
  });

  it("allows the api hosts the renderer fetches", () => {
    assert.ok(directive("connect-src").includes("https:"));
  });
});

describe("isRendererOrigin", () => {
  const rendererOrigin = "https://release-v4-1-3.losbroxas.org";

  it("matches the renderer origin with a path", () => {
    assert.strictEqual(
      isRendererOrigin(
        "https://release-v4-1-3.losbroxas.org/#/library",
        rendererOrigin
      ),
      true
    );
  });

  it("matches the default port normalization", () => {
    assert.strictEqual(
      isRendererOrigin(
        "https://release-v4-1-3.losbroxas.org:443/#/",
        rendererOrigin
      ),
      true
    );
  });

  it("rejects the subdomain prefix trick", () => {
    assert.strictEqual(
      isRendererOrigin(
        "https://evil-release-v4-1-3.losbroxas.org/#/",
        rendererOrigin
      ),
      false
    );
  });

  it("rejects a host appended to the renderer host", () => {
    assert.strictEqual(
      isRendererOrigin(
        "https://release-v4-1-3.losbroxas.org.evil.com/#/",
        rendererOrigin
      ),
      false
    );
  });

  it("rejects a port mismatch", () => {
    assert.strictEqual(
      isRendererOrigin(
        "https://release-v4-1-3.losbroxas.org:8443/#/",
        rendererOrigin
      ),
      false
    );
  });

  it("rejects a scheme downgrade", () => {
    assert.strictEqual(
      isRendererOrigin(
        "http://release-v4-1-3.losbroxas.org/#/",
        rendererOrigin
      ),
      false
    );
  });

  it("rejects everything when the renderer loads local files", () => {
    assert.strictEqual(
      isRendererOrigin("https://release-v4-1-3.losbroxas.org/#/", ""),
      false
    );
  });
});
