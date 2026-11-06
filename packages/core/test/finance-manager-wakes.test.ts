import { describe, expect, it } from "vitest";
import { managerWakes } from "../src/index.ts";

const NOW = new Date("2026-11-05T18:00:00.000Z");
const OPUS = "claude-opus-5-5";
type S = Parameters<typeof managerWakes>[0]["sessions"][number];
let k = 0;
const ses = (over: Partial<S>): S => ({
  id: `se_${k++}`, agentId: "ag_m", purpose: "manage", model: OPUS, bankModel: OPUS, byModel: null,
  startedAt: "2026-11-05T10:00:00.000Z", endedAt: "2026-11-05T10:05:00.000Z",
  input: 0, output: 1_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...over,
});
const agents = [{ id: "ag_m", buildingId: "bank" }, { id: "ag_w", buildingId: "lab" }, { id: "ag_r", buildingId: "bank" }];
const doc = (id: string, decidedBy: string, decidedAt: string) => ({ id, decidedBy, decidedAt });

describe("managerWakes (gr_lwgus14rd2 step 3)", () => {
  it("counts a decision inside a wake, not one outside; two wakes in one day sum", () => {
    const r = managerWakes({
      sessions: [
        ses({}),
        ses({ startedAt: "2026-11-05T10:10:00.000Z", endedAt: "2026-11-05T10:14:00.000Z", output: 3_000 }),
        // yesterday
        ses({ startedAt: "2026-11-04T09:00:00.000Z", endedAt: "2026-11-04T09:03:00.000Z" }),
        // another building's manager; a work session is no wake
        ses({ agentId: "ag_w" }),
        ses({ purpose: "work", output: 50_000 }),
        // 9 days ago: outside the window
        ses({ startedAt: "2026-10-27T09:00:00.000Z", endedAt: "2026-10-27T09:03:00.000Z" }),
      ],
      docs: [
        doc("dc_in1", "ag_m", "2026-11-05T10:02:00.000Z"),
        doc("dc_in2", "ag_m", "2026-11-05T10:12:00.000Z"),
        doc("dc_in3", "ag_m", "2026-11-05T10:13:00.000Z"),
        doc("dc_out", "ag_m", "2026-11-05T10:07:00.000Z"),     // between the wakes
        doc("dc_other", "ag_r", "2026-11-05T10:03:00.000Z"),   // decided by someone else
      ],
      agents,
    }, NOW);
    const bank = r.buildings.bank!;
    expect(bank.days.map((d) => d.day)).toEqual(["2026-11-05", "2026-11-04"]);
    const today = bank.days[0]!;
    expect(today).toMatchObject({ wakes: 2, tokens: 4_000, decided: 3, perWake: 2_000, perDecision: 1_333 });
    expect(bank.days[1]).toMatchObject({ wakes: 1, tokens: 1_000, decided: 0, perDecision: null });
    expect(bank.total).toMatchObject({ wakes: 3, tokens: 5_000, decided: 3 });
    expect(r.buildings.lab!.total).toMatchObject({ wakes: 1, tokens: 1_000, decided: 0 });
    expect(r.total).toMatchObject({ wakes: 4, tokens: 6_000, decided: 3, perWake: 1_500, perDecision: 2_000 });
    expect(r.manageTokens).toBe(6_000);
    expect(r.check.ok).toBe(true);
    expect(today.usd).toBeCloseTo(0.08, 2);
  });

  it("counts a running wake up to now and each decision once", () => {
    const r = managerWakes({
      sessions: [ses({ startedAt: "2026-11-05T17:50:00.000Z", endedAt: null }), ses({ startedAt: "2026-11-05T17:40:00.000Z", endedAt: "2026-11-05T17:55:00.000Z" })],
      docs: [doc("dc_a", "ag_m", "2026-11-05T17:52:00.000Z"), doc("dc_b", "ag_m", "2026-11-05T17:59:00.000Z")],
      agents,
    }, NOW);
    expect(r.total).toMatchObject({ wakes: 2, decided: 2 });
  });
});
