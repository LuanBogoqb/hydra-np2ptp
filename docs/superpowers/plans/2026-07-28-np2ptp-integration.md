# NP2PTP Integration Implementation Plan (Hydra fork)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed the np2ptp daemon as a sidecar in Hydra's Electron main process: `np2ptp:` downloads, convert-to-np2ptp, per-game seeding, and (optional toggle) np2ptp as the torrent engine.

**Architecture:** A new `Np2ptpDaemon` service in the main process mirrors the existing `PythonRPC` sidecar pattern (NDJSON over stdio, id→pending map, `ready` handshake) but adds exponential-backoff restart ×3 and re-provide-from-DB on restart, per `docs/HYDRA-FORK-DESIGN.md`. Desired state (seed toggles, conversion results) lives in Hydra's LevelDB; the daemon only executes.

**Tech Stack:** Electron main (TypeScript), node built-in test runner (`yarn test` = `node --test "src/**/*.test.ts"` via ts-node), classic-level DB, Redux Toolkit renderer, i18next.

## Global Constraints

- Branch: all work on `dev`. `main` only on release.
- np2ptp binary is **not** self-updating; this plan does NOT port BinaryManager (separate follow-up plan; Windows Authenticode `WTD_HASH_ONLY_FLAG` question unresolved — do not rely on the Windows verify path).
- No-copy invariant: converted game files must stay in place; uninstall must `unprovide` + clear refs BEFORE deleting files.
- Daemon protocol (np2ptp v0.1.9), one JSON object per line:
  - Requests: `{"id":N,"cmd":"fetch","uri","out"}`, `{"id":N,"cmd":"convert","torrent","data"}` or `{"id":N,"cmd":"convert","path"}`, `{"id":N,"cmd":"torrent","input","out"?}`, `{"id":N,"cmd":"provide","nptp"}`, `{"id":N,"cmd":"unprovide","root"}`, `{"id":N,"cmd":"status"}`, `{"id":N,"cmd":"shutdown"}`
  - Events: `{"event":"ready","version","peer_id","addrs"}` (no id, once at boot); `{"id","event":"progress","op","done","total"}` (fetch/torrent also carry `"phase":"downloading"|"writing"` — treat as opaque extra field); `{"id","event":"result","ok":true,...fields}`; `{"id","event":"error","ok":false,"message"}`; `{"event":"warn","message"}` (no id).
  - Result fields: fetch → `{root,path,bytes_total}`; convert → `{root,converted,files_total,chunks_total,bytes_total}`; provide → `{root,files_total,chunks_total}`; unprovide → `{root}`; status → `{peers,peer_id,addrs,provided:[],ledger:{served_to_us,we_served,credited_by_receipts}}`.
- Daemon has NO cancel/pause command. Abort of an in-flight op = kill + respawn daemon (fetch resumes cheaply from store chunks; store lives in `userData/np2ptp`).
- Env overrides `NP2PTP_RELAY`/`NP2PTP_TRACKER` pass through untouched (daemon reads them itself).
- i18n: every new user-facing string gets keys in `src/locales/en/translation.json` AND `src/locales/pt-BR/translation.json`.
- Commits: conventional (`feat:`/`fix:`/`test:`), small, after each green task.

## File Structure

```
src/types/np2ptp.types.ts                          — protocol types (events, results)
src/main/services/np2ptp/ndjson.ts                 — pure NDJSON line accumulator/parser
src/main/services/np2ptp/ndjson.test.ts
src/main/services/np2ptp/np2ptp-daemon.ts          — Np2ptpDaemon (spawn/ready/request/restart)
src/main/services/np2ptp/np2ptp-daemon.test.ts
src/main/services/np2ptp/binary-path.ts            — dev/prod binary resolution
src/main/events/library/convert-game-to-np2ptp.ts  — IPC: convert
src/main/events/library/toggle-np2ptp-seed.ts      — IPC: seed toggle
src/shared/constants.ts                            — Downloader.Np2ptp
src/shared/index.ts                                — URI classification
src/main/services/download/download-manager.ts     — np2ptp fetch branch + progress cache
src/types/level.types.ts                           — Download.np2ptpUri/nptpPath/np2ptpSeed, UserPreferences toggles
UI: renderer constants, downloads-section (convert), download-group (seed menu), settings-context-integrations (engine toggle), settings-context-downloads (auto-convert)
```

---

### Task 1: Protocol types + NDJSON parser

**Files:**
- Create: `src/types/np2ptp.types.ts`
- Create: `src/main/services/np2ptp/ndjson.ts`
- Test: `src/main/services/np2ptp/ndjson.test.ts`

**Interfaces:**
- Produces: `Np2ptpEvent` union type; `class NdjsonAccumulator { push(chunk: Buffer | string): Np2ptpEvent[] }` — feeds raw stdout chunks, returns fully-parsed events; malformed lines are skipped (returned as `{event:"warn", message:"unparseable line: ..."}` so nothing throws).

- [ ] **Step 1: Write the failing test**

```ts
// src/main/services/np2ptp/ndjson.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NdjsonAccumulator } from "./ndjson";

describe("NdjsonAccumulator", () => {
  it("parses one complete line", () => {
    const acc = new NdjsonAccumulator();
    const events = acc.push('{"event":"ready","version":"0.1.9","peer_id":"12D3","addrs":["/ip4/1.2.3.4/tcp/1"]}\n');
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "ready");
  });

  it("buffers partial lines across chunks", () => {
    const acc = new NdjsonAccumulator();
    assert.equal(acc.push('{"id":1,"event":"prog').length, 0);
    const events = acc.push('ress","op":"fetch","done":5,"total":10}\n');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { id: 1, event: "progress", op: "fetch", done: 5, total: 10 });
  });

  it("handles multiple lines in one chunk", () => {
    const acc = new NdjsonAccumulator();
    const events = acc.push('{"id":1,"event":"result","ok":true,"root":"np2ptp:ab"}\n{"id":2,"event":"error","ok":false,"message":"boom"}\n');
    assert.equal(events.length, 2);
    assert.equal(events[1].event, "error");
  });

  it("turns malformed lines into warn events instead of throwing", () => {
    const acc = new NdjsonAccumulator();
    const events = acc.push("not json at all\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "warn");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn test 2>&1 | grep -A2 ndjson`
Expected: FAIL — cannot find module `./ndjson`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/types/np2ptp.types.ts
export interface Np2ptpReadyEvent {
  event: "ready";
  version: string;
  peer_id: string;
  addrs: string[];
}

export interface Np2ptpProgressEvent {
  id: number;
  event: "progress";
  op: string;
  done: number;
  total: number;
  phase?: string;
}

export interface Np2ptpResultEvent {
  id: number;
  event: "result";
  ok: true;
  [field: string]: unknown;
}

export interface Np2ptpErrorEvent {
  id: number;
  event: "error";
  ok: false;
  message: string;
}

export interface Np2ptpWarnEvent {
  event: "warn";
  message: string;
}

export type Np2ptpEvent =
  | Np2ptpReadyEvent
  | Np2ptpProgressEvent
  | Np2ptpResultEvent
  | Np2ptpErrorEvent
  | Np2ptpWarnEvent;

export interface Np2ptpStatusResult {
  peers: number;
  peer_id: string;
  addrs: string[];
  provided: string[];
  ledger: { served_to_us: number; we_served: number; credited_by_receipts: number };
}
```

```ts
// src/main/services/np2ptp/ndjson.ts
import type { Np2ptpEvent } from "@types";

export class NdjsonAccumulator {
  private buffer = "";

  public push(chunk: Buffer | string): Np2ptpEvent[] {
    this.buffer += chunk.toString();
    const events: Np2ptpEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        events.push({ event: "warn", message: `unparseable line: ${line}` });
      }
    }
    return events;
  }
}
```

Check `@types` alias resolves in test tsconfig (`tsconfig.test.json`); if not, import relative `../../../types/np2ptp.types` and re-export from `src/types/index.ts` the way sibling type files are.

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn test 2>&1 | tail -5`
Expected: PASS (all 4)

- [ ] **Step 5: Commit**

```bash
git add src/types/np2ptp.types.ts src/main/services/np2ptp/
git commit -m "feat: np2ptp NDJSON protocol types and line parser"
```

---

### Task 2: Np2ptpDaemon — spawn, ready handshake, request correlation

**Files:**
- Create: `src/main/services/np2ptp/np2ptp-daemon.ts`
- Test: `src/main/services/np2ptp/np2ptp-daemon.test.ts`

**Interfaces:**
- Consumes: `NdjsonAccumulator`, `Np2ptpEvent` (Task 1).
- Produces:
  ```ts
  interface DaemonProcessLike {  // subset of ChildProcess, for tests
    stdin: { write(s: string): boolean } | null;
    stdout: NodeJS.EventEmitter | null;
    stderr: NodeJS.EventEmitter | null;
    once(ev: "exit" | "error", cb: (...a: unknown[]) => void): this;
    kill(): boolean;
  }
  class Np2ptpDaemon {
    constructor(opts: {
      spawnFn: () => DaemonProcessLike;      // injected for tests; prod wraps cp.spawn
      onWarn?: (message: string) => void;
      onCrash?: (attempts: number) => void;  // fired when restarts are exhausted
      onRestart?: () => Promise<void>;       // re-provide hook, awaited after ready
      readyTimeoutMs?: number;               // default 10000
    });
    ensureReady(): Promise<Np2ptpReadyEvent>;
    request(cmd: object, opts?: { timeoutMs?: number; onProgress?: (e: Np2ptpProgressEvent) => void }): Promise<Np2ptpResultEvent>;
    killAndRestart(): Promise<void>;         // abort path for in-flight ops
    shutdown(): Promise<void>;               // sends {"cmd":"shutdown"}, then kill after grace
  }
  ```
- `request` auto-assigns `id` (monotonic counter), writes `JSON.stringify({id, ...cmd}) + "\n"`, resolves on matching `result`, rejects on matching `error` or process exit.

- [ ] **Step 1: Write the failing test** (fake process; no real binary)

```ts
// src/main/services/np2ptp/np2ptp-daemon.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Np2ptpDaemon } from "./np2ptp-daemon";

class FakeProc extends EventEmitter {
  public written: string[] = [];
  public stdout = new EventEmitter();
  public stderr = new EventEmitter();
  public stdin = {
    write: (s: string) => {
      this.written.push(s);
      return true;
    },
  };
  public kill() {
    this.emit("exit", 0);
    return true;
  }
  public emitLine(obj: object) {
    this.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
  }
}

const READY = { event: "ready", version: "0.1.9", peer_id: "12D3", addrs: ["/ip4/127.0.0.1/tcp/4001"] };

describe("Np2ptpDaemon", () => {
  it("resolves ensureReady on ready event", async () => {
    const proc = new FakeProc();
    const daemon = new Np2ptpDaemon({ spawnFn: () => proc });
    const readyP = daemon.ensureReady();
    proc.emitLine(READY);
    const ready = await readyP;
    assert.equal(ready.peer_id, "12D3");
  });

  it("correlates interleaved responses by id", async () => {
    const proc = new FakeProc();
    const daemon = new Np2ptpDaemon({ spawnFn: () => proc });
    const readyP = daemon.ensureReady();
    proc.emitLine(READY);
    await readyP;
    const p1 = daemon.request({ cmd: "provide", nptp: "a.nptp" });
    const p2 = daemon.request({ cmd: "status" });
    const id1 = JSON.parse(proc.written[0]).id;
    const id2 = JSON.parse(proc.written[1]).id;
    proc.emitLine({ id: id2, event: "result", ok: true, peers: 3 });
    proc.emitLine({ id: id1, event: "result", ok: true, root: "np2ptp:ab" });
    assert.equal((await p1).root, "np2ptp:ab");
    assert.equal((await p2).peers, 3);
  });

  it("routes progress events to the matching request only", async () => {
    const proc = new FakeProc();
    const daemon = new Np2ptpDaemon({ spawnFn: () => proc });
    const readyP = daemon.ensureReady();
    proc.emitLine(READY);
    await readyP;
    const seen: number[] = [];
    const p = daemon.request(
      { cmd: "fetch", uri: "np2ptp:ab", out: "D:/g" },
      { onProgress: (e) => seen.push(e.done) }
    );
    const id = JSON.parse(proc.written[0]).id;
    proc.emitLine({ id, event: "progress", op: "fetch", done: 1, total: 4 });
    proc.emitLine({ id: 999, event: "progress", op: "fetch", done: 99, total: 100 });
    proc.emitLine({ id, event: "result", ok: true, root: "np2ptp:ab", path: "D:/g", bytes_total: 4 });
    await p;
    assert.deepEqual(seen, [1]);
  });

  it("rejects request on error event", async () => {
    const proc = new FakeProc();
    const daemon = new Np2ptpDaemon({ spawnFn: () => proc });
    const readyP = daemon.ensureReady();
    proc.emitLine(READY);
    await readyP;
    const p = daemon.request({ cmd: "fetch", uri: "np2ptp:zz", out: "D:/g" });
    const id = JSON.parse(proc.written[0]).id;
    proc.emitLine({ id, event: "error", ok: false, message: "no providers" });
    await assert.rejects(p, /no providers/);
  });

  it("rejects all pending requests when the process exits", async () => {
    const proc = new FakeProc();
    const daemon = new Np2ptpDaemon({ spawnFn: () => proc });
    const readyP = daemon.ensureReady();
    proc.emitLine(READY);
    await readyP;
    const p = daemon.request({ cmd: "status" });
    proc.emit("exit", 1);
    await assert.rejects(p, /exited/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn test 2>&1 | grep -B1 -A3 "np2ptp-daemon"`
Expected: FAIL — cannot find module `./np2ptp-daemon`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/services/np2ptp/np2ptp-daemon.ts
import { NdjsonAccumulator } from "./ndjson";
import type {
  Np2ptpEvent,
  Np2ptpProgressEvent,
  Np2ptpReadyEvent,
  Np2ptpResultEvent,
} from "@types";

export interface DaemonProcessLike {
  stdin: { write(s: string): boolean } | null;
  stdout: NodeJS.EventEmitter | null;
  stderr: NodeJS.EventEmitter | null;
  once(ev: "exit" | "error", cb: (...a: unknown[]) => void): this;
  kill(): boolean;
}

interface Pending {
  resolve: (r: Np2ptpResultEvent) => void;
  reject: (e: Error) => void;
  onProgress?: (e: Np2ptpProgressEvent) => void;
  timer?: NodeJS.Timeout;
}

interface Np2ptpDaemonOptions {
  spawnFn: () => DaemonProcessLike;
  onWarn?: (message: string) => void;
  onCrash?: (attempts: number) => void;
  onRestart?: () => Promise<void>;
  readyTimeoutMs?: number;
}

export class Np2ptpDaemon {
  private proc: DaemonProcessLike | null = null;
  private accumulator = new NdjsonAccumulator();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private readyPromise: Promise<Np2ptpReadyEvent> | null = null;
  private readyResolve: ((r: Np2ptpReadyEvent) => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;

  constructor(private readonly options: Np2ptpDaemonOptions) {}

  public ensureReady(): Promise<Np2ptpReadyEvent> {
    if (!this.readyPromise) {
      this.readyPromise = new Promise<Np2ptpReadyEvent>((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
        const timeout = setTimeout(
          () => reject(new Error("np2ptp daemon startup timeout")),
          this.options.readyTimeoutMs ?? 10_000
        );
        timeout.unref?.();
      });
      this.spawn();
    }
    return this.readyPromise;
  }

  private spawn() {
    this.accumulator = new NdjsonAccumulator();
    this.proc = this.options.spawnFn();
    this.proc.stdout?.on("data", (chunk: Buffer) => {
      for (const event of this.accumulator.push(chunk)) this.handleEvent(event);
    });
    this.proc.once("exit", () => this.handleExit());
    this.proc.once("error", () => this.handleExit());
  }

  private handleEvent(event: Np2ptpEvent) {
    if (event.event === "ready") {
      this.readyResolve?.(event);
      return;
    }
    if (event.event === "warn") {
      this.options.onWarn?.(event.message);
      return;
    }
    const entry = this.pending.get(event.id);
    if (!entry) return;
    if (event.event === "progress") {
      entry.onProgress?.(event);
      return;
    }
    this.pending.delete(event.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (event.event === "result") entry.resolve(event);
    else entry.reject(new Error(event.message));
  }

  private handleExit() {
    const error = new Error("np2ptp daemon exited");
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.readyReject?.(error);
    this.readyPromise = null;
    this.proc = null;
  }

  public async request(
    cmd: object,
    opts: { timeoutMs?: number; onProgress?: (e: Np2ptpProgressEvent) => void } = {}
  ): Promise<Np2ptpResultEvent> {
    await this.ensureReady();
    const id = this.nextId++;
    return new Promise<Np2ptpResultEvent>((resolve, reject) => {
      const entry: Pending = { resolve, reject, onProgress: opts.onProgress };
      if (opts.timeoutMs) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("np2ptp request timeout"));
        }, opts.timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      this.proc?.stdin?.write(JSON.stringify({ id, ...cmd }) + "\n");
    });
  }
}
```

Note: `ready` rejection path — the pending `readyReject` after resolve is a no-op (settled promise), safe.

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn test 2>&1 | tail -5`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/services/np2ptp/np2ptp-daemon.ts src/main/services/np2ptp/np2ptp-daemon.test.ts
git commit -m "feat: np2ptp daemon manager with id-correlated NDJSON requests"
```

---

### Task 3: Restart with exponential backoff ×3 + re-provide hook

**Files:**
- Modify: `src/main/services/np2ptp/np2ptp-daemon.ts`
- Test: `src/main/services/np2ptp/np2ptp-daemon.test.ts` (append)

**Interfaces:**
- Produces: after an unexpected exit, daemon re-spawns with delays `[1000, 2000, 4000]` ms (injectable `backoffDelaysMs` option for tests → `[1, 2, 4]`). After each successful respawn (`ready` seen), awaits `onRestart()` (re-provide hook) and resets the attempt counter. After 3 consecutive failures, calls `onCrash(3)` and stays down until the next `ensureReady()`/`request()` call (which starts a fresh cycle). `shutdown()`/`killAndRestart()` do not trigger `onCrash`.

- [ ] **Step 1: Write the failing test** (append to describe block)

```ts
  it("respawns after crash and calls onRestart, resetting attempts on success", async () => {
    const procs: FakeProc[] = [];
    let restarts = 0;
    const daemon = new Np2ptpDaemon({
      spawnFn: () => {
        const p = new FakeProc();
        procs.push(p);
        return p;
      },
      onRestart: async () => {
        restarts++;
      },
      backoffDelaysMs: [1, 2, 4],
    });
    const readyP = daemon.ensureReady();
    procs[0].emitLine(READY);
    await readyP;
    procs[0].emit("exit", 1); // crash
    await new Promise((r) => setTimeout(r, 10)); // let backoff fire
    assert.equal(procs.length, 2);
    procs[1].emitLine(READY);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(restarts, 1);
  });

  it("gives up after 3 failed respawns and reports crash", async () => {
    const procs: FakeProc[] = [];
    let crashed = 0;
    const daemon = new Np2ptpDaemon({
      spawnFn: () => {
        const p = new FakeProc();
        procs.push(p);
        // simulate instant death, never ready
        setTimeout(() => p.emit("exit", 1), 1);
        return p;
      },
      onCrash: (n) => {
        crashed = n;
      },
      backoffDelaysMs: [1, 2, 4],
      readyTimeoutMs: 50,
    });
    daemon.ensureReady().catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(procs.length, 4); // initial + 3 retries
    assert.equal(crashed, 3);
  });

  it("killAndRestart aborts in-flight requests and comes back ready", async () => {
    const procs: FakeProc[] = [];
    const daemon = new Np2ptpDaemon({
      spawnFn: () => {
        const p = new FakeProc();
        procs.push(p);
        return p;
      },
      backoffDelaysMs: [1, 2, 4],
    });
    const readyP = daemon.ensureReady();
    procs[0].emitLine(READY);
    await readyP;
    const inflight = daemon.request({ cmd: "fetch", uri: "np2ptp:ab", out: "D:/g" });
    const restartP = daemon.killAndRestart();
    await assert.rejects(inflight);
    procs[1].emitLine(READY);
    await restartP;
    assert.equal(procs.length, 2);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn test 2>&1 | tail -10`
Expected: FAIL — `backoffDelaysMs` unknown / respawn not happening (procs.length stays 1)

- [ ] **Step 3: Implement**

In `np2ptp-daemon.ts`:
- Add options: `backoffDelaysMs?: number[]` (default `[1000, 2000, 4000]`).
- Add fields: `private attempts = 0; private intentionalExit = false;`
- In `handleExit()`: after rejecting pendings, if `intentionalExit` → reset flag, return (no auto-respawn). Else if `attempts < backoffDelaysMs.length`: schedule `setTimeout(() => this.respawn(), backoffDelaysMs[this.attempts++])` (unref). Else call `options.onCrash?.(this.attempts)` and reset `attempts = 0`.
- `respawn()`: create fresh `readyPromise` (same wiring as `ensureReady`), `spawn()`, then on ready: `attempts = 0; await options.onRestart?.()`.
- `killAndRestart()`: set `intentionalExit = true`, `proc?.kill()`, call `handleExit` path synchronously (mirror `PythonRPC.kill()` at `src/main/services/python-rpc.ts:422-429`), then `respawn()` and return its ready promise.
- `shutdown()`: `intentionalExit = true`; try `await request({cmd:"shutdown"}, {timeoutMs: 3000})` (ignore failure); then `proc?.kill()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn test 2>&1 | tail -5`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/services/np2ptp/
git commit -m "feat: np2ptp daemon exponential-backoff restart and re-provide hook"
```

---

### Task 4: Binary path resolution + singleton wiring + app lifecycle

**Files:**
- Create: `src/main/services/np2ptp/binary-path.ts`
- Create: `src/main/services/np2ptp/index.ts`
- Modify: `src/main/main.ts` (startup bootstrap area, near `bootstrapDownloadsOnStartup` at :123)
- Modify: `electron-builder.yml:5-9` (`extraResources`)

**Interfaces:**
- Produces:
  ```ts
  // binary-path.ts
  export function getNp2ptpBinaryPath(): string;
  // index.ts
  export const np2ptp: Np2ptpDaemon;      // singleton, prod spawnFn
  export async function reprovideAllFromDb(): Promise<void>;
  ```
- Resolution order: `process.env.NP2PTP_BIN` if set → packaged: `path.join(process.resourcesPath, "np2ptp", "np2ptp.exe" | "np2ptp")` → dev fallback: `E:\Repos\np2ptp\target\release\np2ptp.exe` is NOT hardcoded; instead dev requires `NP2PTP_BIN` and index.ts logs a clear warn + daemon stays unavailable if missing (graceful: Hydra works, np2ptp features error with toast).
- Spawn args: `[ "daemon", "--store", path.join(SystemPath.getPath("userData"), "np2ptp") ]`, `stdio: ["pipe","pipe","pipe"]`, `windowsHide: true`, env passthrough (`NP2PTP_RELAY`/`NP2PTP_TRACKER` ride along).
- `reprovideAllFromDb()`: iterate `downloadsSublevel`, for every record with `np2ptpSeed === true && nptpPath` → `np2ptp.request({cmd:"provide", nptp: record.nptpPath})`, errors → logger.warn (never throw). Passed as `onRestart`. Also called once at boot after first `ensureReady()`.
- `onCrash` → `WindowManager.sendToAppWindows("on-np2ptp-crashed")` (add channel in Task 8 UI wiring; here just the send).
- App quit: hook Hydra's existing shutdown path where PythonRPC is killed (search `PythonRPC.kill()` call site in `main.ts` / window-manager) → also `await np2ptp.shutdown()`.
- electron-builder.yml: add `- np2ptp` to `extraResources` list (dir at repo root holding the packaged binary; CI story is follow-up, dir can be gitignored-empty for now with `.gitkeep`).

No unit test (thin glue over Electron APIs; smoke-tested in Task 10 manual run). Type-check gate instead.

- [ ] **Step 1: Implement the three files + yml edit** (as specified above)
- [ ] **Step 2: Type-check**

Run: `corepack yarn typecheck` (if script missing: `npx tsc --noEmit -p tsconfig.json`)
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add src/main/services/np2ptp/ src/main/main.ts electron-builder.yml np2ptp/.gitkeep
git commit -m "feat: np2ptp daemon lifecycle wiring and binary resolution"
```

---

### Task 5: Downloader enum + URI classification + display names

**Files:**
- Modify: `src/shared/constants.ts:1-15` (enum)
- Modify: `src/shared/index.ts:134-171` (`getDownloadersForUri`)
- Modify: `src/renderer/src/constants.ts:3-15` (`DOWNLOADER_NAME`)
- Modify: `src/big-picture/src/constants.ts:12` (mirror map)
- Test: `src/shared/index.test.ts` (create if absent)

**Interfaces:**
- Produces: `Downloader.Np2ptp = 14` (append — NEVER renumber existing members, they're persisted in user DBs); `getDownloadersForUri("np2ptp:<hex>")` → `[Downloader.Np2ptp]`; display name `"NP2PTP"`.

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/index.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDownloadersForUri } from "./index";
import { Downloader } from "./constants";

describe("getDownloadersForUri", () => {
  it("classifies np2ptp uris", () => {
    assert.deepEqual(getDownloadersForUri("np2ptp:deadbeef"), [Downloader.Np2ptp]);
  });

  it("still classifies magnets without np2ptp", () => {
    const result = getDownloadersForUri("magnet:?xt=urn:btih:abc");
    assert.ok(result.includes(Downloader.Torrent));
    assert.ok(!result.includes(Downloader.Np2ptp));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn test 2>&1 | tail -8`
Expected: FAIL — `Np2ptp` not a member / empty array

- [ ] **Step 3: Implement**

`constants.ts`: append `Np2ptp = 14,` to the enum. `index.ts` `getDownloadersForUri`: before the magnet branch add:

```ts
if (uri.startsWith("np2ptp:")) {
  return [Downloader.Np2ptp];
}
```

Both constants maps: `[Downloader.Np2ptp]: "NP2PTP",`.

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn test 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/ src/renderer/src/constants.ts src/big-picture/src/constants.ts
git commit -m "feat: recognize np2ptp: uris as a downloader"
```

---

### Task 6: Download flow — fetch via daemon, progress into Hydra's model

**Files:**
- Modify: `src/main/services/download/download-manager.ts` (`startDownload:1761`, `getDownloadStatus:590`, `cancelDownload:1035`, `pauseDownload:1012`, `isHttpDownloader:262`)
- Modify: `src/types/level.types.ts:83` (`Download`: add `np2ptpUri?: string; nptpPath?: string; np2ptpSeed?: boolean;`)
- Test: none new (logic lives in daemon manager already tested; manager wiring is glue over tested `request`) — manual smoke in Task 10.

**Interfaces:**
- Consumes: `np2ptp` singleton (Task 4), `Downloader.Np2ptp` (Task 5).
- Produces: `Downloader.Np2ptp` branch in `startDownload`:
  ```ts
  case Downloader.Np2ptp: {
    const gameId = levelKeys.game(download.shop, download.objectId);
    this.np2ptpProgress.set(gameId, { done: 0, total: 0 });
    np2ptp
      .request(
        { cmd: "fetch", uri: download.uri, out: download.downloadPath },
        { onProgress: (e) => this.np2ptpProgress.set(gameId, { done: e.done, total: e.total }) }
      )
      .then((result) => this.np2ptpDone.set(gameId, result))
      .catch((err) => this.np2ptpFailed.set(gameId, err));
    break;
  }
  ```
  Three static maps on DownloadManager: `np2ptpProgress: Map<string, {done:number,total:number}>`, `np2ptpDone`, `np2ptpFailed`.
- `getDownloadStatus` gains an np2ptp branch (mirrors the RPC branch's return shape): reads the maps, computes `progress = total ? done/total : 0`, `downloadSpeed` derived from delta of `done` vs the previous poll divided by poll interval (store `lastDone`/`lastTs` alongside), `numPeers`/`numSeeds` 0. When `np2ptpDone` has the gameId → return progress 1 so `shouldFinalizeDownload` → `handleDownloadCompletion` fires, then clear all three maps for the key; fetch results already land bridged (record `np2ptpUri = result.root as string`, `nptpPath` stays unset — fetch stores manifest in-store) — persist via `downloadsSublevel.put`. When `np2ptpFailed` → surface as the same error path other downloaders use (`handleDownloadError`), clear maps.
- `pauseDownload`/`cancelDownload` for np2ptp: `await np2ptp.killAndRestart()` (aborts fetch; store keeps chunks so resume re-fetches only the remainder), clear the three maps for that key. Resume = plain `startDownload` again.
- `isHttpDownloader`: np2ptp is NOT http → update the check: `downloader !== Downloader.Torrent && downloader !== Downloader.Np2ptp`.
- Error copy (i18n keys added in Task 9): fetch error containing "no providers" → key `np2ptp_no_providers` ("Nobody is seeding this content right now").

- [ ] **Step 1: Implement** (as specified — follow the surrounding switch/branch style in each site)
- [ ] **Step 2: Type-check + full test suite**

Run: `npx tsc --noEmit -p tsconfig.json && corepack yarn test 2>&1 | tail -3`
Expected: clean + PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/services/download/download-manager.ts src/types/level.types.ts
git commit -m "feat: route np2ptp downloads through the daemon with progress mapping"
```

---

### Task 7: Convert IPC + auto-convert on completion

**Files:**
- Create: `src/main/events/library/convert-game-to-np2ptp.ts`
- Modify: `src/main/events/index.ts` (register import)
- Modify: `src/preload/index.ts` (~:467, follow `getUserPreferences` pattern)
- Modify: `src/renderer/src/declaration.d.ts` (~:447)
- Modify: `src/main/services/download/download-manager.ts` (`handleDownloadCompletion:673`) — auto-convert hook
- Modify: `src/types/level.types.ts:135` (`UserPreferences`: add `np2ptpAutoConvert?: boolean; useNp2ptpForTorrents?: boolean;` — both here so Task 8/9 don't touch types again)

**Interfaces:**
- Produces IPC `convertGameToNp2ptp(shop: GameShop, objectId: string): Promise<{ uri: string }>`:
  ```ts
  // convert-game-to-np2ptp.ts (registerEvent pattern, copy toggle-automatic-cloud-sync.ts structure)
  const download = await downloadsSublevel.get(levelKeys.game(shop, objectId));
  if (!download) throw new Error("no download record");
  const payload =
    download.downloader === Downloader.Torrent
      ? { cmd: "convert", torrent: torrentFilePathFor(download), data: downloadFolder }
      : { cmd: "convert", path: downloadFolder };
  const result = await np2ptp.request(payload, { timeoutMs: 30 * 60_000 });
  await downloadsSublevel.put(key, { ...download, np2ptpUri: result.root as string, nptpPath: nptpPathFrom(result) });
  return { uri: result.root as string };
  ```
  where `downloadFolder = path.join(download.downloadPath, download.folderName!)`. For the torrent `.torrent` file path: Hydra's python sidecar exposes `torrent_files` RPC — if a cached `.torrent` path isn't recoverable there, fall back to `{cmd:"convert", path}` (unverified) and note it in the returned payload as `verified: false`; UI copy states the difference (Task 9 keys `np2ptp_convert_verified` / `np2ptp_convert_unverified`).
  `nptpPathFrom(result)`: convert result carries `root`; the `.nptp` manifest lands in the daemon store's `manifests/` dir — derive `path.join(SystemPath.getPath("userData"), "np2ptp", "manifests", rootHexFrom(result.root) + ".nptp")` with `rootHexFrom("np2ptp:<hex>") = uri.slice(7)`. Verify dir layout once against a real convert during Task 10 smoke; adjust in one place if the store names differ.
- Auto-convert: at the end of `handleDownloadCompletion`, if `(await getUserPreferences())?.np2ptpAutoConvert && download.downloader === Downloader.Torrent` → fire-and-forget the same convert routine, errors → logger + toast channel `on-np2ptp-warn`.
- Failure semantics: daemon guarantees no partial `.nptp` on piece-hash mismatch; the IPC just rethrows the daemon message.

- [ ] **Step 1: Implement** (registerEvent + preload + declaration + completion hook)
- [ ] **Step 2: Type-check + tests**

Run: `npx tsc --noEmit -p tsconfig.json && corepack yarn test 2>&1 | tail -3`
Expected: clean + PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/events/ src/preload/index.ts src/renderer/src/declaration.d.ts src/types/level.types.ts src/main/services/download/download-manager.ts
git commit -m "feat: convert-to-np2ptp IPC with optional auto-convert on completion"
```

---

### Task 8: Seed toggle IPC + startup/restart re-provide + uninstall unprovide

**Files:**
- Create: `src/main/events/library/toggle-np2ptp-seed.ts`
- Modify: `src/main/events/index.ts`, `src/preload/index.ts`, `src/renderer/src/declaration.d.ts`
- Modify: `src/main/main.ts` (bootstrap: after `bootstrapDownloadsOnStartup`, call `np2ptp.ensureReady().then(reprovideAllFromDb).catch(logger.warn)` — lazy, non-blocking)
- Modify: game removal path — find delete flow via `gamesSublevel`/`downloadsSublevel` removal events (`src/main/events/library/` remove/delete handlers): before file deletion, if `download.np2ptpUri` → `np2ptp.request({cmd:"unprovide", root: download.np2ptpUri}).catch(logger.warn)` and clear `np2ptpSeed`.

**Interfaces:**
- Produces IPC `toggleNp2ptpSeed(shop, objectId, enabled: boolean): Promise<void>` — copy `toggle-automatic-cloud-sync.ts:1` structure: get record, `enabled ? provide(nptpPath) : unprovide(np2ptpUri)`, then `downloadsSublevel.put(key, { ...download, np2ptpSeed: enabled })`. Requires `nptpPath || np2ptpUri` present, else throws "game is not converted".
- No-copy invariant enforced here: unprovide BEFORE delete (Global Constraints).

- [ ] **Step 1: Implement**
- [ ] **Step 2: Type-check + tests**

Run: `npx tsc --noEmit -p tsconfig.json && corepack yarn test 2>&1 | tail -3`
Expected: clean + PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/ src/preload/index.ts src/renderer/src/declaration.d.ts
git commit -m "feat: per-game np2ptp seed toggle with re-provide on boot and unprovide on delete"
```

---

### Task 9: Settings toggles + i18n strings

**Files:**
- Modify: `src/renderer/src/pages/settings/settings-context-integrations.tsx` (add "NP2PTP" group: `useNp2ptpForTorrents` toggle)
- Modify: `src/renderer/src/pages/settings/settings-context-downloads.tsx:220-228` (append `np2ptpAutoConvert` CheckboxField next to `seed_after_download_complete`)
- Modify: `src/locales/en/translation.json`, `src/locales/pt-BR/translation.json`

**Interfaces:**
- Consumes: `UserPreferences.useNp2ptpForTorrents` / `np2ptpAutoConvert` (Task 7 types), `settingsContext.updateUserPreferences` — exact `CheckboxField` pattern from `settings-context-downloads.tsx:220-228`.
- i18n keys (both locales — en shown, pt-BR translated):
  ```json
  "use_np2ptp_for_torrents": "Use NP2PTP as torrent engine",
  "use_np2ptp_for_torrents_description": "Route magnet and torrent downloads through the NP2PTP network instead of libtorrent. Completed downloads are instantly seedable on NP2PTP.",
  "np2ptp_auto_convert": "Convert downloads to NP2PTP automatically",
  "np2ptp_convert": "Convert to NP2PTP",
  "np2ptp_convert_success": "Game converted — NP2PTP link copied to your library entry",
  "np2ptp_convert_unverified": "You are publishing what is on disk, as is (origin unverified)",
  "np2ptp_no_providers": "Nobody is seeding this content right now",
  "np2ptp_seed": "Seed on NP2PTP",
  "np2ptp_stop_seed": "Stop seeding on NP2PTP",
  "np2ptp_copy_link": "Copy NP2PTP link",
  "np2ptp_daemon_crashed": "NP2PTP stopped responding and could not be restarted"
  ```
  pt-BR: "Usar NP2PTP como engine de torrent", "Baixar magnets e torrents pela rede NP2PTP em vez do libtorrent. Downloads concluídos ficam prontos pra semear no NP2PTP.", "Converter downloads pro NP2PTP automaticamente", "Converter pro NP2PTP", "Jogo convertido — link NP2PTP salvo na sua biblioteca", "Você está publicando o que está no disco, como está (origem não verificada)", "Ninguém está semeando esse conteúdo agora", "Semear no NP2PTP", "Parar de semear no NP2PTP", "Copiar link NP2PTP", "O NP2PTP parou de responder e não conseguiu reiniciar"

- [ ] **Step 1: Implement** (toggles + all keys in both files)
- [ ] **Step 2: Type-check + build renderer**

Run: `npx tsc --noEmit -p tsconfig.web.json 2>&1 | tail -3`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/pages/settings/ src/locales/en/translation.json src/locales/pt-BR/translation.json
git commit -m "feat: np2ptp settings toggles and locale strings"
```

---

### Task 10: Game-page UI (convert button, seed menu, crash toast) + manual smoke

**Files:**
- Modify: `src/renderer/src/pages/game-details/modals/game-options-modal/downloads-section.tsx` (convert button + copy-link + unverified note)
- Modify: `src/renderer/src/pages/downloads/download-group.tsx:826-847` (context menu: `np2ptp_seed`/`np2ptp_stop_seed`, gated on `game.download?.np2ptpUri != null`; mirror `stop_seeding` entries)
- Modify: `src/renderer/src/app.tsx:138` area (subscribe `on-np2ptp-crashed` → `showErrorToast(t("np2ptp_daemon_crashed"))`; `on-np2ptp-warn` → warning toast)
- Modify: `src/preload/index.ts` (the two `on-np2ptp-*` listeners, follow `onDownloadProgress:131` pattern)

**Interfaces:**
- Consumes: `window.electron.convertGameToNp2ptp` (Task 7), `window.electron.toggleNp2ptpSeed` (Task 8), toast pattern `useToast()` per `hero-panel-actions.tsx:63,166`.
- Convert button behavior: disabled while converting (local `useState`), on success `showSuccessToast(t("np2ptp_convert_success"))` + context game refresh (`updateGame()` from `gameDetailsContext`), on error `showErrorToast(err.message)`. Copy-link button visible when `game.download?.np2ptpUri` — `navigator.clipboard.writeText(uri)`.

- [ ] **Step 1: Implement**
- [ ] **Step 2: Type-check everything**

Run: `npx tsc --noEmit -p tsconfig.web.json && npx tsc --noEmit -p tsconfig.json`
Expected: clean

- [ ] **Step 3: Manual smoke (dev run)**

Run: `set NP2PTP_BIN=<path-to>np2ptp.exe && corepack yarn dev`
Checklist: app boots with daemon ready (log line); settings shows both toggles; a converted game shows copy-link; seed toggle flips without error; killing np2ptp.exe in Task Manager → app recovers (backoff) and re-provides.
If no np2ptp.exe is built locally: `cd E:\Repos\np2ptp && cargo build --release -p np2ptp-node`.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/ src/preload/index.ts
git commit -m "feat: np2ptp convert and seed UI on game pages"
```

---

### Task 11: Torrent-engine toggle routing

**Files:**
- Modify: `src/main/services/download/download-manager.ts` (`startDownload:1761` — the `Downloader.Torrent` path)
- Test: none (glue; covered by manual smoke)

**Interfaces:**
- Consumes: `UserPreferences.useNp2ptpForTorrents` (Task 7 types), daemon `torrent` cmd.
- Produces: in `startDownload`, when `download.downloader === Downloader.Torrent && (await getUserPreferences())?.useNp2ptpForTorrents` → instead of the PythonRPC payload, run the np2ptp branch from Task 6 but with `{ cmd: "torrent", input: download.uri, out: path.join(download.downloadPath, download.folderName ?? "") }`; on result, persist `np2ptpUri = result.root` (torrent downloads arrive auto-bridged → instantly convertible-free and seed-togglable). Progress/abort/error handling identical to Task 6 (same three maps).
- Documented trade-off (already in design doc): no ongoing BitTorrent seeding for these downloads; np2ptp-side seeding only.
- Selective file download (`fileIndices`) is NOT supported by the daemon `torrent` cmd — when `download.fileIndices?.length` is set, ignore the toggle and use the classic libtorrent path (silent, correct fallback).

- [ ] **Step 1: Implement**
- [ ] **Step 2: Type-check + tests**

Run: `npx tsc --noEmit -p tsconfig.json && corepack yarn test 2>&1 | tail -3`
Expected: clean + PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/services/download/download-manager.ts
git commit -m "feat: optional np2ptp torrent engine behind settings toggle"
```

---

## Deferred (explicitly OUT of this plan)

- **BinaryManager/AuthenticodeVerifier port** (np2ptp self-update ownership) — own plan; blocked on the `WTD_HASH_ONLY_FLAG` fixtures question.
- **CI packaging of np2ptp.exe into releases** (build.yml/release.yml step) — follow-up with the BinaryManager plan.
- **Status view "seeding N games, X GB served"** — nice-to-have; `status` cmd already returns the data (`provided`, `ledger.we_served`), UI later.
- **34-locale translation sweep** — en + pt-BR only for now, rest fall back to en.
