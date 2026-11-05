/** Outbox request helpers (1:1 mt_pr3347g2w2 decision 7): withdrawn and declined requests share one group, a bad pill and a decision line. */
import { describe, expect, it } from "vitest";
import type { Doc } from "@muster-town/schema";
import { requestDecisionLine, requestGroup, requestTone } from "../src/panels/requests";

const base = { id: "dc_1", type: "request", state: "building", title: "t", body: "b", authorId: "ag_x", authorKind: "agent", buildingId: null, provenance: { sourceIds: [], urls: [] }, tags: [], createdAt: "2026-11-05T19:00:00.000Z", updatedAt: "2026-11-05T19:00:00.000Z" } as Doc;

describe("outbox request helpers", () => {
  it("three tabs: open is Pending, claimed is Claimed, and done with declined, withdrawn and legacy rejected is Done", () => {
    expect(["open", "claimed", "done"].map((s) => requestGroup(s as Doc["requestStatus"]))).toEqual(["open", "claimed", "done"]);
    expect(["declined", "withdrawn", "rejected"].map((s) => requestGroup(s as Doc["requestStatus"]))).toEqual(["done", "done", "done"]);
    expect(requestGroup(undefined)).toBe("open");
  });
  it("the pill is bad only for the ones that left the outbox undone", () => {
    expect(requestTone("declined")).toBe("bad");
    expect(requestTone("withdrawn")).toBe("bad");
    expect(requestTone("done")).toBe("ok");
  });
  it("the decision line names who, via whom, and the note", () => {
    expect(requestDecisionLine({ ...base, requestStatus: "withdrawn", requestNote: "Replaced by dc_2." })).toBe("Withdrawn: Replaced by dc_2.");
    expect(requestDecisionLine({ ...base, requestStatus: "declined", requestNote: 'by Mitchell via Secretary in mt_1: "decline it"', requestDecidedById: "us_m", requestViaAgentId: "ag_s", requestViaMeetingId: "mt_1" })).toMatch(/^Declined by .* via .* in mt_1: by Mitchell via Secretary/);
  });
});
