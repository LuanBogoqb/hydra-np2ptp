const MAX_EXTERNAL_URL_LENGTH = 2048;
const SAFE_PROTOCOLS = new Set(["http:", "https:"]);

// Allowlist for anything that reaches shell.openExternal. URIs come from
// hostile content (game/shop descriptions rendered as links, theme
// metadata), so only plain http/https without userinfo may leave the app.
export function isSafeExternalUrl(url: string): boolean {
  if (url.length > MAX_EXTERNAL_URL_LENGTH) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (!SAFE_PROTOCOLS.has(parsed.protocol)) return false;

  // Userinfo in the authority is never legitimate here and is a classic
  // smuggling vector (https://%6a%61vascript@example.com/).
  if (!parsed.hostname || parsed.username || parsed.password) return false;

  // Percent-decoding must not change what the URL means: re-parse the
  // decoded href and require the same protocol, otherwise the string the
  // OS handler sees is not the string we validated.
  try {
    const decoded = new URL(decodeURIComponent(parsed.href));
    if (decoded.protocol !== parsed.protocol) return false;
  } catch {
    return false;
  }

  return true;
}
