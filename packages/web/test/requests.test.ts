/** Outbox request helpers (1:1 mt_pr3347g2w2 decision 7): withdrawn and declined requests share one group, a bad pill and a decision line. */
import { describe, expect, it } from "vitest";
import type { Doc } from "@muster-town/schema";
import { requestDecisionLine, requestTone } from "../src/panels/requests";

const base = { id: "dc_1", type: "request", state: "building", title: "t", body: "b", authorId: "ag_x", authorKind: "agent", buildingId: null, provenance: { sourceIds: [], urls: [] }, tags: [], createdAt: "2026-11-05T19:00:00.000Z", updatedAt: "2026-11-05T19:00:00.000Z" } as Doc;

describe("request helpers", () => {
  it("the pill is bad only for the ones that ended undone", () => {
    expect(requestTone("declined")).toBe("bad");
    expect(requestTone("withdrawn")).toBe("bad");
    expect(requestTone("done")).toBe("ok");
  });
  it("the decision line names who, via whom, and the note", () => {
    expect(requestDecisionLine({ ...base, requestStatus: "withdrawn", requestNote: "Replaced by dc_2." }, (id) => id)).toBe("Withdrawn: Replaced by dc_2.");
    expect(requestDecisionLine({ ...base, requestStatus: "declined", requestNote: 'by Mitchell via Secretary in mt_1: "decline it"', requestDecidedById: "us_m", requestViaAgentId: "ag_s", requestViaMeetingId: "mt_1" }, (id) => ({ us_m: "Mitchell", ag_s: "Secretary" })[id] ?? id)).toBe('Declined by Mitchell via Secretary in mt_1: by Mitchell via Secretary in mt_1: "decline it"');
  });
});
