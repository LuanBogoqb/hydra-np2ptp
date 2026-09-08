export interface PublishTarget {
  owner: string;
  repo: string;
}

const PUBLISH_KEY = /^\s+(provider|owner|repo):\s*["']?([^"'\s]+)["']?\s*$/;

// Minimal parse of the `publish:` block: enough for the single-entry
// electron-builder.yml this fork ships with. No yaml dependency.
export const readPublishTarget = (builderYml: string): PublishTarget | null => {
  const lines = builderYml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^publish:\s*$/.test(line));
  if (start === -1) return null;

  const target: Partial<Record<"owner" | "repo", string>> = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s/.test(line)) break; // dedent ends the block

    const match = PUBLISH_KEY.exec(line);
    if (match) target[match[1] as "owner" | "repo"] = match[2];
    if (target.owner && target.repo) break;
  }

  return target.owner && target.repo
    ? { owner: target.owner, repo: target.repo }
    : null;
};

const SET_FEED_URL_GITHUB =
  /setFeedURL\(\s*\{\s*provider:\s*["']github["'],\s*owner:\s*["']([^"']+)["'],\s*repo:\s*["']([^"']+)["'],?\s*\}\s*\)/g;

// Every explicit setFeedURL github object literal in a TS source. An explicit
// feed here wins over electron-builder.yml, so any hit is an override.
export const findSetFeedUrlOverrides = (tsSource: string): PublishTarget[] =>
  [...tsSource.matchAll(SET_FEED_URL_GITHUB)].map((match) => ({
    owner: match[1],
    repo: match[2],
  }));
