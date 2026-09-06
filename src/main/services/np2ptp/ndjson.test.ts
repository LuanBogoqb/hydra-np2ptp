import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NdjsonAccumulator } from "./np2ptp-daemon.ts";

describe("NdjsonAccumulator", () => {
  it("parses one complete line", () => {
    const acc = new NdjsonAccumulator();
    const events = acc.push(
      '{"event":"ready","version":"0.1.9","peer_id":"12D3","addrs":["/ip4/1.2.3.4/tcp/1"]}\n'
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "ready");
  });

  it("buffers partial lines across chunks", () => {
    const acc = new NdjsonAccumulator();
    assert.equal(acc.push('{"id":1,"event":"prog').length, 0);
    const events = acc.push('ress","op":"fetch","done":5,"total":10}\n');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      id: 1,
      event: "progress",
      op: "fetch",
      done: 5,
      total: 10,
    });
  });

  it("handles multiple lines in one chunk", () => {
    const acc = new NdjsonAccumulator();
    const events = acc.push(
      '{"id":1,"event":"result","ok":true,"root":"np2ptp:ab"}\n{"id":2,"event":"error","ok":false,"message":"boom"}\n'
    );
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
