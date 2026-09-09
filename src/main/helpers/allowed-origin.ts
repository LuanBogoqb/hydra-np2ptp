// Schemes that never hand the window to a remote origin. about:blank is what
// Chromium uses for empty frames; devtools:/chrome-extension: only show up in
// dev tooling and locally installed extensions.
const TRUSTED_LOCAL_SCHEMES = new Set([
  "about:",
  "devtools:",
  "chrome-extension:",
]);

// Comparison origin of a URL: protocol+host+port, host already lowercased by
// the URL parser (so punycode lookalikes never compare equal). Opaque origins
// (file:, data:, javascript:) report as "null", so the scheme alone stands in
// for them: a window loaded from a local file may only navigate to other
// local files, never to a remote origin.
export function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === "null" ? parsed.protocol : parsed.origin;
  } catch {
    return "";
  }
}

// True when navigatingTo stays on the origin the window was loaded from.
// Anything unknown, unparseable or cross-origin is a deny; callers decide
// whether a denied URL may still leave through shell.openExternal.
export function isAllowedOrigin(
  navigatingTo: string,
  currentOrigin: string
): boolean {
  let next: URL;
  try {
    next = new URL(navigatingTo);
  } catch {
    return false;
  }

  if (TRUSTED_LOCAL_SCHEMES.has(next.protocol)) return true;

  const nextOrigin = originOf(navigatingTo);

  // Unknown origin on either side: deny by default.
  if (!nextOrigin || !currentOrigin) return false;

  return nextOrigin === currentOrigin;
}
