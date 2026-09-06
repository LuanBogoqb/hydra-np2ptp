# CLAUDE.md: guide for AI agents working on hydra-np2ptp

This repo is a fork of `hydralauncher/hydra` (Electron + React + TypeScript, with a Python
sidecar for libtorrent and a Rust native addon). The fork adds `np2ptp`, a custom Rust P2P
protocol, as an alternative download/seed/torrent transport alongside Hydra's existing
BitTorrent and direct-download paths. The np2ptp protocol itself lives in a separate repo,
`E:\Repos\np2ptp-project\np2ptp` (its own `CLAUDE.md`); this repo only embeds and drives the
`np2ptp` binary, it does not implement the protocol.

## Fork discipline

Get this right before touching anything.

- **Base and branch:** upstream is `hydralauncher/hydra` (remote `upstream`). `origin` is
  `LuanBogoqb/hydra-np2ptp`. Work happens on `dev-4.1.3`, rebased onto upstream tag `v4.1.3`.
  `main` is release-only.
- **The fork's own delta is exactly `git diff v4.1.3..dev-4.1.3`**: 48 files, ~3387 lines
  added. `docs/STATUS.md` is the authoritative, dated account of what is actually implemented;
  `docs/HYDRA-FORK-DESIGN.md` is the original design intent and is explicitly marked stale in
  places (STATUS.md wins on disagreement; the update-signature mechanism is one such case,
  called out inline in the design doc).
- **Fork-owned, safe to change freely:** `src/main/services/np2ptp/`,
  `src/main/events/library/{convert-game-to-np2ptp,toggle-np2ptp-seed}.ts`,
  `src/main/helpers/migrate-np2ptp-downloader-id.ts`, `src/types/np2ptp.types.ts`,
  `scripts/dev-np2ptp.mjs`, `scripts/fetch-np2ptp-binary.mjs`,
  `.github/workflows/np2ptp-installer.yml`, `native/hydra-native/src/signature.rs`, and both
  `docs/` files above.
- **Upstream files the fork extends (append-only, do not restructure):**
  `src/main/services/download/download-manager.ts` (wires np2ptp into the existing download
  state machine), `src/main/main.ts`, `src/main/index.ts`, `src/preload/index.ts`,
  `src/renderer/src/app.tsx`, `src/shared/index.ts`, `src/shared/constants.ts`,
  `src/types/level.types.ts`, `electron-builder.yml`, a few renderer pages under
  `downloads/`, `game-options-modal/`, `settings/`, and locale JSON files. `package.json` is
  deliberately untouched, per STATUS.md, keep it that way.
- **Everything else** (rest of `src/`, `native/hydra-native/` outside `signature.rs`,
  `python_rpc/`, most CI workflows) **is upstream**. Treat as vendored: fix only what you must.
- **Merging upstream updates:** upstream rewrites `main` on release, so `git merge upstream/main`
  is unusable (stale merge-base). Per `docs/STATUS.md`: branch off the new upstream tag,
  regenerate the fork's diff with `git diff <old-fork-point>..<current-branch>`, `git apply -3`
  it onto the new base, resolve, then commit as one "port np2ptp integration to hydra X.Y.Z".

## Build & test

Windows is the primary dev host (see `docs/STATUS.md`'s "Dev environment" section to recreate
`.venv312` or `.env` after a machine rebuild).

```sh
yarn                          # installs deps; postinstall builds the Rust native addon
node scripts/dev-np2ptp.mjs   # preferred dev entrypoint: points HYDRA_PYTHON_BIN at .venv312
                               # (do not set that var in the user env, it would also redirect
                               # the installed production Hydra build)
yarn dev                      # plain upstream dev entrypoint (electron-vite dev)

yarn typecheck                # tsc --noEmit for node (main/preload) and web (renderer)
yarn test                     # node --test via ts-node loader; covers Np2ptpDaemon and
                               # update-helpers; 4 pre-existing failures are unrelated to the
                               # fork (EPERM temp cleanup, two short-path/8.3 assertions)
yarn lint / format            # eslint --fix / prettier

yarn build:win|mac|linux      # build:native + build:python-rpc + electron-vite build + electron-builder
```

Python: `.venv312` (3.12.10, libtorrent 2.1.1.0, cx_Freeze 7.2.3) backs the libtorrent sidecar;
recreate with `python -m venv .venv312 && .venv312/Scripts/pip install -r requirements.txt`.
`.env` at repo root carries 6 keys, including `MAIN_VITE_NIMBUS_API_URL` (not in `.env.example`);
only `MAIN_VITE_*`/`RENDERER_VITE_*` vars reach the app, electron-vite injects nothing else.
Husky's pre-commit runs `format`, pre-push runs `lint` then `typecheck`.

## Golden rules

1. **`Downloader.Np2ptp = 100`, never 14.** Upstream 4.1.0 claimed id 14 for its own Archive.org
   downloader; the fork uses a private range so upstream's sequence can never collide with it.
   (The design doc still says 14 in one place; that is a historical artifact, not a target.)
2. **`migrate-np2ptp-downloader-id.ts` keys on the URI scheme, not the stored number**, when
   re-tagging legacy DB rows, so it can tell an old np2ptp row apart from a genuine Archive.org
   row an official Hydra build wrote as id 14. Matching by number alone would corrupt those.
3. **No-copy invariant:** converting a game to np2ptp stores absolute-path references, never
   duplicates game data. Any change to `convert-game-to-np2ptp.ts` or `delete-game-folder.ts`
   must keep `unprovide` and ref cleanup happening before deletion, not after.
4. **`getNp2ptpBinaryPath()`'s resolution order is load-bearing:** `NP2PTP_BIN` env override,
   then the updater-managed binary in `userData/np2ptp-bin`, then the packaged
   `resources/np2ptp/` seed, else `null` (features disabled, not a crash). Reordering breaks
   either the dev override or self-update (the managed path must win over the read-only seed).
5. **Binary update verification is minisign-only, one key, one path for both OSes**
   (`update-helpers.ts`, `binary-updater.ts`, `verify_minisign` in `signature.rs`). There is
   deliberately no Authenticode check here, that belongs to the separate `np2ptp-gui` project;
   the design doc calls this out explicitly as a deviation from the original plan.
6. **`electron-builder.yml`'s `publish:` points at `LuanBogoqb/hydra-np2ptp`, not
   `hydralauncher/hydra`.** It feeds electron-updater; pointing it at upstream would make a
   packaged fork build silently update itself into vanilla Hydra and drop np2ptp.
7. **CI publishes prereleases only, and `update-aur.yml`/`trigger-lp.yml` are guarded with
   `if: github.repository == 'hydralauncher/hydra'`.** This keeps a fork build from pushing to
   upstream's AUR package or landing page, or surfacing to electron-updater as a real release.
8. **Desired seed state lives in Hydra's local DB; the daemon only executes it.** On restart,
   Hydra re-issues `provide` for every game whose DB-persisted toggle is on. The daemon's own
   in-memory state must never become the source of truth, it does not survive a crash.

## Conventions

- Conventional Commits (commitlint uses `@commitlint/config-conventional`); recent fork commits
  use `feat:`, `chore:`, `ci:`, `docs:` prefixes with a plain-English summary, no scope tags
  required. Match this style, not upstream's occasional `fix(scope): ...` PR-squash style, when
  the commit is fork-only work.
- `.cursorrules` at repo root governs code style for this whole tree: use `logger` (from
  `@main/services` or `@renderer/logger`), never raw `console.*`; all user-facing strings go
  through i18next (`useTranslation`) and land in `src/locales/en/translation.json` (and the
  `pt-BR` counterpart); prefer named exports for utilities/services; fix ESLint errors properly
  before reaching for a disable comment, and justify any disable inline.
- Rust code in `native/hydra-native/` follows the existing module layout under
  `src/cloud_save/`, `src/signature.rs`, etc.; keep additions additive rather than
  restructuring existing modules, for the same upstream-merge reason as the TypeScript side.

## Layout

`src/main/services/np2ptp/` is the daemon integration core: `np2ptp-daemon.ts` (NDJSON
child-process protocol, id-correlated request/response, crash backoff), `binary-path.ts`
(binary resolution), `binary-updater.ts` / `update-helpers.ts` (self-update, minisign
verification), and `index.ts` (service wiring). `src/main/events/library/` holds the two
IPC-exposed actions (`convert-game-to-np2ptp.ts`, `toggle-np2ptp-seed.ts`). `src/types/np2ptp.types.ts`
defines the daemon's event/command shapes shared across main and tests. `scripts/dev-np2ptp.mjs`
is the fork's dev launcher; `scripts/fetch-np2ptp-binary.mjs` seeds `np2ptp/` (gitignored except
`.gitkeep`) with a verified release binary before packaging, reusing the same minisign helpers
as runtime. `docs/STATUS.md` is the living source of truth for what is actually built and
verified; `docs/HYDRA-FORK-DESIGN.md` is the original design record; check STATUS.md first for
anything current. Everything else under `src/`, `native/hydra-native/` (bar `signature.rs`),
and `python_rpc/` is upstream Hydra.
