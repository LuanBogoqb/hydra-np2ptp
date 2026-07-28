import type {
  Np2ptpEvent,
  Np2ptpProgressEvent,
  Np2ptpReadyEvent,
  Np2ptpResultEvent,
} from "../../../types/np2ptp.types";

// Lives in this file (not a sibling module) because the repo's node --test +
// ts-node setup cannot resolve extensionless relative value imports at test
// runtime, and the build tsconfig rejects extensioned ones.
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

export interface DaemonProcessLike {
  stdin: { write(s: string): boolean } | null;
  stdout: NodeJS.EventEmitter | null;
  stderr: NodeJS.EventEmitter | null;
  once(ev: "exit" | "error", cb: (...a: unknown[]) => void): this;
  kill(): boolean;
}

interface PendingRequest {
  resolve: (r: Np2ptpResultEvent) => void;
  reject: (e: Error) => void;
  onProgress?: (e: Np2ptpProgressEvent) => void;
  timer?: NodeJS.Timeout;
}

export interface Np2ptpDaemonOptions {
  spawnFn: () => DaemonProcessLike;
  onWarn?: (message: string) => void;
  onStderr?: (chunk: string) => void;
  onCrash?: (attempts: number) => void;
  onRestart?: () => Promise<void>;
  readyTimeoutMs?: number;
  backoffDelaysMs?: number[];
}

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000];

export class Np2ptpDaemon {
  private proc: DaemonProcessLike | null = null;
  private accumulator = new NdjsonAccumulator();
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private readyPromise: Promise<Np2ptpReadyEvent> | null = null;
  private readyResolve: ((r: Np2ptpReadyEvent) => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private respawnTimer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private intentionalExit = false;
  private everReady = false;

  constructor(private readonly options: Np2ptpDaemonOptions) {}

  private get backoffDelays(): number[] {
    return this.options.backoffDelaysMs ?? DEFAULT_BACKOFF_MS;
  }

  public ensureReady(): Promise<Np2ptpReadyEvent> {
    // A pending backoff respawn already owns a readyPromise — await it rather
    // than spawning a second daemon onto the same store.
    if (!this.readyPromise) {
      this.createReadyPromise();
      this.spawn();
    }
    return this.readyPromise!;
  }

  private createReadyPromise() {
    this.readyPromise = new Promise<Np2ptpReadyEvent>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.readyTimer = setTimeout(() => {
        reject(new Error("np2ptp daemon startup timeout"));
        // Kill the stuck process; its exit handler re-enters the backoff
        // ladder and replaces this readyPromise with a fresh one.
        this.proc?.kill();
      }, this.options.readyTimeoutMs ?? 10_000);
      this.readyTimer.unref?.();
    });
    // Internal respawns have no external awaiter; keep a handler attached so a
    // startup failure never surfaces as an unhandled rejection.
    this.readyPromise.catch(() => {});
  }

  private spawn() {
    this.accumulator = new NdjsonAccumulator();

    let proc: DaemonProcessLike;
    try {
      proc = this.options.spawnFn();
    } catch (err) {
      this.proc = null;
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyReject?.(error);
      this.readyPromise = null;
      return;
    }

    this.proc = proc;
    proc.stdout?.on("data", (chunk: Buffer) => {
      if (this.proc !== proc) return;
      for (const event of this.accumulator.push(chunk)) {
        this.handleEvent(event);
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      this.options.onStderr?.(chunk.toString());
    });
    const onGone = () => this.handleExit(proc);
    proc.once("exit", onGone);
    proc.once("error", onGone);
  }

  private handleEvent(event: Np2ptpEvent) {
    if (event.event === "ready") {
      if (this.readyTimer) clearTimeout(this.readyTimer);
      const wasRespawn = this.everReady;
      this.everReady = true;
      this.attempts = 0;
      this.readyResolve?.(event);
      if (wasRespawn && this.options.onRestart) {
        void this.options.onRestart().catch(() => {});
      }
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
    if (event.event === "result") {
      entry.resolve(event);
    } else {
      entry.reject(new Error(event.message));
    }
  }

  private handleExit(proc: DaemonProcessLike | null) {
    // A killed process emits its real "exit" after killAndRestart has already
    // moved on to a fresh daemon — ignore events from anything but the
    // current process so they cannot tear the replacement down.
    if (!proc || this.proc !== proc) return;
    this.proc = null;

    const error = new Error("np2ptp daemon exited");
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyReject?.(error);
    this.readyPromise = null;

    if (this.intentionalExit) {
      this.intentionalExit = false;
      return;
    }

    if (this.attempts < this.backoffDelays.length) {
      const delay = this.backoffDelays[this.attempts];
      this.attempts += 1;
      // The new readyPromise exists NOW so ensureReady/request during the
      // backoff window await it instead of spawning a competing daemon.
      this.createReadyPromise();
      this.respawnTimer = setTimeout(() => {
        this.respawnTimer = null;
        this.spawn();
      }, delay);
      this.respawnTimer.unref?.();
    } else {
      this.options.onCrash?.(this.attempts);
      this.attempts = 0;
    }
  }

  public async request(
    cmd: object,
    opts: {
      timeoutMs?: number;
      onProgress?: (e: Np2ptpProgressEvent) => void;
    } = {}
  ): Promise<Np2ptpResultEvent> {
    await this.ensureReady();
    const id = this.nextId++;
    return new Promise<Np2ptpResultEvent>((resolve, reject) => {
      if (!this.proc?.stdin) {
        reject(new Error("np2ptp daemon exited"));
        return;
      }
      const entry: PendingRequest = {
        resolve,
        reject,
        onProgress: opts.onProgress,
      };
      if (opts.timeoutMs) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("np2ptp request timeout"));
        }, opts.timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      this.proc.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
    });
  }

  public async killAndRestart(): Promise<void> {
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    const proc = this.proc;
    this.intentionalExit = true;
    proc?.kill();
    // FakeProc/real ChildProcess may emit "exit" synchronously or later; run
    // the cleanup now either way (identity check makes a second run a no-op).
    this.handleExit(proc);
    this.intentionalExit = false;
    this.createReadyPromise();
    this.spawn();
    await this.readyPromise;
  }

  public async shutdown(): Promise<void> {
    this.intentionalExit = true;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    if (!this.proc) return;
    try {
      await this.request({ cmd: "shutdown" }, { timeoutMs: 3000 });
    } catch {
      // daemon may already be gone; kill below is the fallback
    }
    this.proc?.kill();
  }
}
