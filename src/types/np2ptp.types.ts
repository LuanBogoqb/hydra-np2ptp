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
  ledger: {
    served_to_us: number;
    we_served: number;
    credited_by_receipts: number;
  };
}
