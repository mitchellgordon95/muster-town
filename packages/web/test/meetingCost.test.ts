import { describe, expect, it, vi } from "vitest";
import { MockApi } from "../src/mock/server";

vi.mock("../src/panels/Markdown", () => ({ Markdown: () => null, DocText: () => null, docIdsIn: () => [] }));
const { workCostLine } = await import("../src/panels/MeetingPanel");

// gr_k71b7b6px7 step 2 (kr_ig4qu7vil3): an ended meeting's panel says what the work asked for in it cost
describe("meeting panel: Work asked for here", () => {
  it("says N assignments, X adj. tokens, $Y, and nothing when no work names the meeting", () => {
    expect(workCostLine({ assignments: 32, tokens: 3_510_000, usd: 512.4 })).toBe("Work asked for here: 32 assignments, 3.5M adj. tokens, $512.40");
    expect(workCostLine({ assignments: 1, tokens: 40_000, usd: 5 })).toMatch(/^Work asked for here: 1 assignment, /);
    expect(workCostLine({ assignments: 0, tokens: 0, usd: 0 })).toBeNull();
  });

  it("the mock's finished 1:1 carries a cost the line can show", async () => {
    const api = new MockApi();
    const open = await api.openOneOnOne("bl_carbon");
    expect((await api.meetingCost(open.id)).assignments).toBe(0); // still live: no line
    const done = await api.endMeeting(open.id);
    expect(done.phase).toBe("done");
    const c = await api.meetingCost(done.id);
    expect(c.assignments).toBeGreaterThan(0);
    expect(c.ids[0]).toBe(done.id);
  });
});
