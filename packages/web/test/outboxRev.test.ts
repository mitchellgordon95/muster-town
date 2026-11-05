import { describe, expect, it } from "vitest";
import { store } from "../src/state";

const doc = (id: string, type: string) => ({
  id, type, title: id, body: "", authorId: "ag_x", buildingId: "workshop", state: "building", tags: [],
  createdAt: "2026-11-05T21:00:00.000Z", updatedAt: "2026-11-05T21:00:00.000Z",
});

/** The Outbox keys its loads on `outboxRev` (live check dc_a019go9663: keyed on `rev`, a busy town kept it on "Loading…" 5 s+). */
describe("outboxRev: moves only when the Outbox's lists can have changed", () => {
  it("a note, meeting-notes or report doc frame bumps rev but not outboxRev", () => {
    const before = store.state.outboxRev;
    store.putDocs([doc("dc_note1", "note") as never, doc("dc_rep1", "report") as never]);
    expect(store.state.outboxRev).toBe(before);
  });
  it("a request or human-report doc, an outbox count or a dropped doc bumps it", () => {
    let n = store.state.outboxRev;
    store.putDocs([doc("dc_req1", "request") as never]);
    expect(store.state.outboxRev).toBe(++n);
    store.putDocs([doc("dc_hr1", "human-report") as never]);
    expect(store.state.outboxRev).toBe(++n);
    store.dropDoc("dc_req1");
    expect(store.state.outboxRev).toBe(++n);
    store.receive({ type: "outbox", open: 3 });
    expect(store.state.outboxRev).toBe(++n);
    expect(store.state.outbox).toBe(3);
  });
});
