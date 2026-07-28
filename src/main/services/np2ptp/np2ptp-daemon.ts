import { NdjsonAccumulator } from "./ndjson.ts";
import type {
  Np2ptpEvent,
  Np2ptpProgressEvent,
  Np2ptpReadyEvent,
  Np2ptpResultEvent,
} from "../../../types/np2ptp.types";

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
  private attempts = 0;
  private intentionalExit = false;
  private everReady = false;

  constructor(private readonly options: Np2ptpDaemonOptions) {}

  private get backoffDelays(): number[] {
    return this.options.backoffDelaysMs ?? DEFAULT_BACKOFF_MS;
  }

  public ensureReady(): Promise<Np2ptpReadyEvent> {
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
      this.readyTimer = setTimeout(
        () => reject(new Error("np2ptp daemon startup timeout")),
        this.options.readyTimeoutMs ?? 10_000
      );
      this.readyTimer.unref?.();
    });
    // Internal respawns have no external awaiter; keep a handler attached so a
    // startup failure never surfaces as an unhandled rejection.
    this.readyPromise.catch(() => {});
  }

  private spawn() {
    this.accumulator = new NdjsonAccumulator();
    this.proc = this.options.spawnFn();
    this.proc.stdout?.on("data", (chunk: Buffer) => {
      for (const event of this.accumulator.push(chunk)) {
        this.handleEvent(event);
      }
    });
    const onGone = () => this.handleExit();
    this.proc.once("exit", onGone);
    this.proc.once("error", onGone);
  }

  private handleEvent(event: Np2ptpEvent) {
    if (event.event === "ready") {
      if (this.readyTimer) clearTimeout(this.readyTimer);
      const wasRespawn = this.everReady;
      this.everReady = true;
      this.attempts = 0;
      this.readyResolve?.(event);
      if (wasRespawn) {
        void this.options.onRestart?.();
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

  private handleExit() {
    if (!this.proc) return;
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
      const timer = setTimeout(() => this.respawn(), delay);
      timer.unref?.();
    } else {
      this.options.onCrash?.(this.attempts);
      this.attempts = 0;
    }
  }

  private respawn(): Promise<Np2ptpReadyEvent> {
    this.createReadyPromise();
    this.spawn();
    return this.readyPromise!;
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
      this.proc?.stdin?.write(JSON.stringify({ id, ...cmd }) + "\n");
    });
  }

  public async killAndRestart(): Promise<void> {
    this.intentionalExit = true;
    this.proc?.kill();
    // FakeProc/real ChildProcess emit "exit" synchronously or async; ensure state
    // is cleared even if the event has not fired yet (mirrors PythonRPC.kill).
    this.handleExit();
    await this.respawn();
  }

  public async shutdown(): Promise<void> {
    this.intentionalExit = true;
    try {
      await this.request({ cmd: "shutdown" }, { timeoutMs: 3000 });
    } catch {
      // daemon may already be gone; kill below is the fallback
    }
    this.proc?.kill();
  }
}
