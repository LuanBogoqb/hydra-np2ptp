import { originOf } from "./allowed-origin";

// The one Content-Security-Policy for the renderer. In production the document
// comes from the remote release host, where the local <meta> tag never
// applies, so the same policy is injected as a response header (window-manager)
// and mirrored verbatim into the local html files (html cannot import it).
// Artwork may come from any https host (steamgriddb, steamstatic) and the
// renderer talks to the Hydra API/auth/nimbus hosts, hence the https: sources;
// 'unsafe-inline' stays in script-src/style-src because the remote bundle and
// the theme editor's #custom-css rely on them.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self' local: blob:",
  "script-src 'self' local: 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' local: data: blob: https:",
  "media-src 'self' local: blob: data:",
  "connect-src 'self' local: https: wss:",
  "font-src 'self' data:",
  "object-src 'none'",
].join("; ");

// True when url is served by the renderer origin itself: the dev server or the
// remote release host in production. An empty renderer origin means windows
// loaded local files, which carry their own <meta> policy — nothing matches.
// Strict origin comparison, so a sibling subdomain or a different port never
// matches.
export function isRendererOrigin(url: string, rendererOrigin: string): boolean {
  if (!rendererOrigin) return false;

  return originOf(url) === rendererOrigin;
}
