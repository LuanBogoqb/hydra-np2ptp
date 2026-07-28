import type { Np2ptpEvent } from "../../../types/np2ptp.types";

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
