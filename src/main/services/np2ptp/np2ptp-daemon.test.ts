import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Np2ptpDaemon } from "./np2ptp-daemon.ts";

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

const READY = {
  event: "ready",
  version: "0.1.9",
  peer_id: "12D3",
  addrs: ["/ip4/127.0.0.1/tcp/4001"],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(0);
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
    await sleep(0);
    const id = JSON.parse(proc.written[0]).id;
    proc.emitLine({ id, event: "progress", op: "fetch", done: 1, total: 4 });
    proc.emitLine({
      id: 999,
      event: "progress",
      op: "fetch",
      done: 99,
      total: 100,
    });
    proc.emitLine({
      id,
      event: "result",
      ok: true,
      root: "np2ptp:ab",
      path: "D:/g",
      bytes_total: 4,
    });
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
    await sleep(0);
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
    await sleep(0);
    proc.emit("exit", 1);
    await assert.rejects(p, /exited/);
  });

  it("forwards warn events", async () => {
    const warns: string[] = [];
    const proc = new FakeProc();
    const daemon = new Np2ptpDaemon({
      spawnFn: () => proc,
      onWarn: (m) => warns.push(m),
    });
    const readyP = daemon.ensureReady();
    proc.emitLine(READY);
    await readyP;
    proc.emitLine({ event: "warn", message: "missing no-copy source" });
    assert.deepEqual(warns, ["missing no-copy source"]);
  });

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
    procs[0].emit("exit", 1);
    await sleep(15);
    assert.equal(procs.length, 2);
    procs[1].emitLine(READY);
    await sleep(15);
    assert.equal(restarts, 1);
  });

  it("gives up after 3 failed respawns and reports crash", async () => {
    const procs: FakeProc[] = [];
    let crashed = 0;
    const daemon = new Np2ptpDaemon({
      spawnFn: () => {
        const p = new FakeProc();
        procs.push(p);
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
    await sleep(100);
    assert.equal(procs.length, 4);
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
    const inflight = daemon.request({
      cmd: "fetch",
      uri: "np2ptp:ab",
      out: "D:/g",
    });
    await sleep(0);
    const restartP = daemon.killAndRestart();
    await assert.rejects(inflight);
    procs[1].emitLine(READY);
    await restartP;
    assert.equal(procs.length, 2);
  });
});
