# Hydra Launcher × NP2PTP — Fork Design (Part 2)

**Date:** 2026-07-27
**Status:** Approved design, not yet implemented. The fork does not exist yet.
**Home:** this document belongs to the Hydra fork, NOT to the np2ptp repo.
The np2ptp side of the work (daemon, multi-manifest serve, bridge output dir
and progress, configurable endpoints, self-update) shipped separately in
`np2ptp` and is documented there on its own terms, with no Hydra specifics.

## What np2ptp already provides for this

Everything the fork needs landed in np2ptp v0.1.9:

- `np2ptp daemon` — one long-lived process owning the store, identity and
  network, driven by NDJSON on stdin/stdout. Commands: `fetch`, `convert`,
  `torrent`, `provide`, `unprovide`, `dial`, `status`, `shutdown`. Events
  carry the id of the request they belong to. `ready` reports the peer id
  and the listen addresses.
- `serve` accepting several manifests, or `--all` over the store registry.
- `torrent --out <dir>` plus download progress, so a BitTorrent download
  lands in the game folder and reports as it goes.
- `NP2PTP_RELAY` / `NP2PTP_TRACKER` environment overrides, so an embedder
  is not pinned to the author's infrastructure.

## The fork owns keeping np2ptp current

np2ptp does not update itself, by design. The application that bundles it
does, exactly as `np2ptp-gui` already does with its `BinaryManager`:

- Ask GitHub for the latest np2ptp release.
- Compare its tag against the bundled binary's version.
- Download the platform asset and verify it before trusting it. On Windows
  that means the Authenticode signer thumbprint has to match one the fork
  accepts; the certificate is documented in np2ptp's README. On Linux there
  is no Authenticode, so verify the SHA-256 against the release's
  `SHA256SUMS` asset, which the np2ptp release workflow publishes.
- Refuse anything that fails verification, delete the download, and keep the
  binary that is already there.
- A running executable cannot be overwritten on Windows, so rename the
  current one aside, write the new one in its place, and clean up the old
  copy on the next successful start.
- Keep a list of accepted signer thumbprints rather than a single one, so a
  certificate renewal does not lock every install out of updates. A new
  thumbprint has to ship in a build that already trusts it before the old
  one can be dropped.

Port this from `np2ptp-gui/src/Np2ptpGui/Services/BinaryManager.cs` and its
`AuthenticodeVerifier`. That verifier extracts the signer thumbprint without
requiring chain trust, which is what makes a self-signed release certificate
usable.

**Open question inherited from that port:** whether `WTD_HASH_ONLY_FLAG`
still verifies the PKCS#7 signature or only recomputes the PE image hash. If
it is the latter, a thumbprint pin is defeatable, because the certificate is
public and can be grafted onto another payload. Two negative fixtures answer
it: the same executable re-signed with a different certificate, and a genuine
one with a flipped byte and a recomputed SpcIndirectData hash but a stale
signature. Settle this before the fork relies on the Windows path.

## Part 2 — Hydra fork

### Sidecar: `Np2ptpDaemonManager` (Electron main process)

Mirrors Hydra's existing Python/libtorrent sidecar pattern:

- Spawns the bundled `np2ptp.exe daemon` at app boot.
- Routes NDJSON events via an `id → callback` map.
- On crash: exponential backoff, 3 attempts, then a visible warning.
- On restart: re-issues `provide` for every game whose seed toggle is ON.
  **Desired state lives in Hydra's local DB; the daemon only executes.**
- `np2ptp.exe` ships in the Electron build resources.

### Downloader

- `Np2ptp` added to the shared `Downloader` enum.
- URI classification recognizes the `np2ptp:` scheme and routes to the daemon
  (`cmd fetch`). Community sources need no structural change — it's one more
  URI type in their JSON lists.
- Progress events map onto Hydra's download model; speed derived in TS from
  event deltas.

### Torrent engine toggle

- Global setting **"Use NP2PTP as torrent engine"** (default OFF).
- ON: magnets/.torrents route to the daemon (`cmd torrent`) instead of the
  Python libtorrent sidecar. Files land in the normal game folder (`--out`).
- Side effect: such downloads arrive already bridged — the game is instantly
  convertible-free and seed-togglable.
- Documented trade-off: after completion, seeding happens on the NP2PTP side
  only; there is no ongoing BitTorrent seeding for these downloads (librqbit
  seeds only while its session runs the download).
- Bonus inherited from the bridge: before hitting the BitTorrent swarm,
  `resolve_or_convert` checks whether the content is already available on the
  NP2PTP network and prefers it.

### Conversion UX

- Button "Convert to NP2PTP" on a downloaded game's page:
  - Torrent-sourced → `cmd convert` with `.torrent` + data dir (verified, no-copy).
  - Direct download → `cmd convert` pack path (no-copy; UI states once that
    origin is unverified — "you are publishing what is on disk, as is").
- Result (`np2ptp:` URI + `.nptp` path) persisted on the download record;
  copy-link button in the UI.
- Global setting "Convert automatically after download" (default OFF) —
  enqueues the same `cmd convert` on download completion.

### Seeding UX

- Per-game toggle in the same UI region as Hydra's torrent seeding.
  ON → `cmd provide`; OFF → `cmd unprovide`; state persisted in Hydra's DB.
- Simple status view ("seeding N games, X GB served") fed by `cmd status`.

## Data flow & error handling

**Layout.** NP2PTP store (fetched chunks, `refs.tsv`, `identity.key`) lives in
Hydra's appData. Game data stays where it is; no-copy stores absolute-path
references, cross-volume is fine. Nothing is duplicated.

**No-copy invariant** (files must stay in place, unchanged):

1. Uninstall via Hydra → fork `unprovide`s and clears refs *before* deleting.
2. Moved/deleted outside Hydra → daemon fails the chunk read, answers "chunk
   unavailable" to the peer (never crashes), emits `warn`; Hydra marks the
   game "conversion broken — reconvert".
3. Game update replaces files → same handling, but Hydra knows it caused it
   and marks the conversion stale at update time, without waiting for a failure.

**Conversion failures.** Piece-hash mismatch → clear UI error, no partial
`.nptp` left behind.

**Daemon death.** Backoff restart ×3; in-flight fetch/convert operations fail
with a toast + retry button — no automatic retry of heavy operations.

**Fetch with no providers.** Configurable timeout, honest message ("nobody is
seeding this content right now") — same UX slot as Hydra's stalled-torrent state.

## Testing

**NP2PTP (Rust, TDD):**

- **3-step golden invariant:** CI test running the README's `pack`/`serve`/
  `fetch` flow, comparing output byte-for-byte against golden files. Guards
  the governing constraint.
- Multi-manifest: new `np2ptp-sim` scenario (one serve, two manifests, both
  fetchable by another node) added to the CI scenario assertions.
- Daemon: integration test spawning the real binary, speaking NDJSON over
  stdio — fetch fixture, convert fixture, provide/unprovide, interleaved ids.
  Golden tests for event shapes.
- Bridge: unit tests for the `--out` parameter and progress events, using the
  crate's existing fake-torrent infra.

**Hydra fork (TypeScript):**

- Unit: NDJSON parser/router (id correlation under interleaving), daemon
  manager restart logic with a fake child process (dies → backoff →
  re-provide from DB state).
- E2E: manual smoke — small np2ptp download, convert an existing torrent,
  enable seed, fetch from a second peer (VPS or Pi) to close the loop.

## Process

- All work on `dev` in both repos; `main` only on release.
- TDD throughout; subagent-driven development with the cavecrew agents
  (model tiering per Luan's dispatch rule).
- Implementation order: Patch 1 → 2 → 3 → 4 → Hydra fork (clone + map first).
