import fs from "node:fs";
import path from "node:path";

// Root confinement for the privileged "local:" scheme. The renderer may only
// read files the app itself placed on disk (artwork caches, cropped temp
// images) — never arbitrary user files. Fail-closed: anything that cannot be
// resolved to a real file inside one of the roots returns null and the
// protocol handler answers 403.
//
// This module must stay free of electron imports so the colocated test can
// load it without touching the real userData; the caller passes the roots in.

const SCHEME = "local:";

// Windows paths are case-insensitive (drive letter included); POSIX is not.
const CASE_INSENSITIVE = process.platform === "win32";

// Same parsing the handler has always used: everything after the scheme is
// treated as a filesystem path, then percent-decoded and resolved against
// the cwd. Kept byte-compatible with the previous implementation so the
// URLs the renderer builds today ("local:C:/..." opaque paths, "local:/abs")
// resolve exactly as before.
const parseRequestPath = (url: string): string | null => {
  if (!url.startsWith(SCHEME)) return null;

  const rawPath = url.slice(SCHEME.length);
  if (!rawPath) return null;

  try {
    return path.resolve(decodeURI(rawPath));
  } catch {
    // Malformed percent-escape: not a path we can reason about.
    return null;
  }
};

const normalizeForCompare = (value: string): string =>
  CASE_INSENSITIVE ? value.toLowerCase() : value;

// Is the real path a file strictly inside `root`? path.relative gives ".."
// segments (or an absolute path when the two are on different drives) for
// anything that escapes the root, and "" for the root itself. The escape test
// is segment-scoped: a file legitimately named "...cache.webp" inside the
// root must not be read as an escape just because its name starts with "..".
const isInsideRoot = (realPath: string, root: string): boolean => {
  const relative = path.relative(path.resolve(root), realPath);
  const escapes = relative === ".." || relative.startsWith(".." + path.sep);
  return relative !== "" && !path.isAbsolute(relative) && !escapes;
};

export type RealPathFn = (filePath: string) => Promise<string>;

export interface ResolveLocalUrlOptions {
  // Directory allowlist, computed at call time (they depend on userData).
  roots: readonly string[];
  // Seam for tests; defaults to the real filesystem realpath, which also
  // collapses symlink/junction escapes before the containment check. Used for
  // both the requested file and the roots.
  realpath?: RealPathFn;
}

// Returns the real path to serve, or null when the URL is not a file inside
// one of the roots (missing file, traversal, symlink escape, bad encoding).
export async function resolveLocalUrl(
  url: string,
  options: ResolveLocalUrlOptions
): Promise<string | null> {
  const resolvedPath = parseRequestPath(url);
  if (!resolvedPath) return null;

  const realpath = options.realpath ?? fs.promises.realpath;

  let realPath: string;
  try {
    realPath = await realpath(resolvedPath);
  } catch {
    // Missing file, broken link, permission error: nothing to serve.
    return null;
  }

  // Roots go through the same realpath as the file side, or the containment
  // check compares two names for the same directory: app.getPath("temp") can
  // hand out the 8.3 short form (C:\Users\LUANBO~1\...) while realpath of a
  // file inside it returns the long form, and a junction-relocated userData
  // does the same. A root that does not exist yet keeps its literal path —
  // no file inside it can be real anyway.
  const realRoots = await Promise.all(
    options.roots.map((root) =>
      realpath(path.resolve(root)).catch(() => path.resolve(root))
    )
  );

  const realForCompare = normalizeForCompare(realPath);

  for (const realRoot of realRoots) {
    if (isInsideRoot(realForCompare, normalizeForCompare(realRoot))) {
      return realPath;
    }
  }

  return null;
}
