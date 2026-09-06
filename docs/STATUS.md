# Fork status

**Base:** upstream `hydralauncher/hydra` v4.1.3 (2026-09-04)
**Branch:** `dev-4.1.3` — port of the np2ptp integration onto that base
**Previous base:** v4.0.6, kept as `archive/np2ptp-hydra-4.0.6`
**Last verified:** 2026-09-06

## How this fork tracks upstream

Upstream rewrites its `main` branch, so a fork commit's base stops being an
ancestor of upstream after a release. `git merge upstream/main` reports a
merge-base from May 2024 and is not usable. Update the fork by re-applying the
patch instead:

```sh
git fetch upstream --tags
git branch archive/np2ptp-hydra-<old> <current-branch>
git checkout -b dev-<new> v<new>
git diff <fork-point>..<current-branch> -- . ':(exclude)tsconfig.node.tsbuildinfo' | git apply -3
# resolve, then commit as one "port np2ptp integration to hydra <new>"
```

The fork's own delta is small (42 files, ~2900 added lines) and deliberately
additive, which is what keeps this cheap. Two properties worth preserving:
`package.json` is untouched, and no upstream file is restructured — only
appended to.

## Downloader id

`Downloader.Np2ptp = 100`, not 14. Upstream 4.1.0 assigned 14 to its own
Archive.org downloader. The id never leaves the machine — it is derived from
the uri in `getDownloadersForUri` (`src/shared/index.ts`) and persisted in the
level DB (`Download.downloader`) — so the fork took a private range that
upstream's sequence will not reach. The plan document in
`docs/superpowers/plans/` still says 14; it is a historical record of the
2026-07-28 design and was left as written.

`src/main/helpers/migrate-np2ptp-downloader-id.ts` re-tags legacy rows on boot,
keyed on the uri scheme rather than the stored number, so an Archive.org row
written as 14 by an official Hydra build is left alone.

## Dev environment (Windows)

- `.env` at the repo root — 6 keys, including `MAIN_VITE_NIMBUS_API_URL`, which
  `.env.example` does not list. It lives on the E: drive and survived the
  2026-08-21 C: reinstall.
- `yarn` comes from corepack; `~/bin/yarn.cmd` forwards to it and is on the user
  PATH. Husky's pre-commit hook runs `yarn run format`, so commits fail without
  it.
- `.venv312` — Python 3.12.10, libtorrent 2.1.1.0, cx_Freeze 7.2.3
  (`python -m venv .venv312 && .venv312/Scripts/pip install -r requirements.txt`).
- Start the app with `node scripts/dev-np2ptp.mjs`, which points
  `HYDRA_PYTHON_BIN` at that venv. Setting the variable in the user environment
  would also redirect the installed production Hydra, and `.env` cannot carry it
  because electron-vite only injects `MAIN_VITE_*` / `RENDERER_VITE_*`.
- Dev shares userData with the installed production Hydra: the game library it
  operates on is the real one.

## Verified on this base

`yarn typecheck:node`, `yarn typecheck:web`, `yarn build` and `yarn format-check`
all pass. `yarn test` passes for both np2ptp suites (`Np2ptpDaemon`, `np2ptp
update helpers`).

Four failures in `yarn test` are pre-existing: a pristine checkout of v4.1.3
with no fork code fails exactly the same tests on this machine.

- `notification-icon.test.ts` — EPERM removing its temp dir
- `wine.test.ts` "resolves the active profile from user.reg" — the expectation
  hardcodes a long user-profile path; the runner's TMP is the 8.3 short form
- `cloud-save/custom-path.test.ts` — two symlink/canonicalization cases, same
  short-path cause

## Not done yet

- No runtime click-test of the ported UI. The build is verified, the app has not
  been driven on this base.
- np2ptp itself is still v0.1.10 (2026-07-29); no new release to pick up.
- Minisign key: still only pinned in the fork. Backing it up (Bitwarden + cold)
  is outstanding from the original work.
- `np2ptp.exe` is not packaged by the fork's CI.
