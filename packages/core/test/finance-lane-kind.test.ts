import { describe, expect, it } from "vitest";
import { laneKindRow, spendByLaneKind } from "../src/index.ts";

const NOW = new Date("2026-11-04T18:00:00.000Z");
const OPUS = "claude-opus-5-5";
const HAIKU = "claude-haiku-5-5";
type S = Parameters<typeof spendByLaneKind>[0]["sessions"][number];
const ses = (over: Partial<S>): S => ({
  agentId: "ag_a", assignmentId: null, purpose: "work", lane: null, model: OPUS, bankModel: OPUS, byModel: null,
  startedAt: "2026-11-04T10:00:00.000Z", endedAt: "2026-11-04T11:00:00.000Z",
  input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...over,
});
const assignments = [
  { id: "a_grant", buildingId: "bank", lane: "grant" as const },
  { id: "a_explore", buildingId: "lab", lane: "exploration" as const },
];
const agents = [{ id: "ag_a", buildingId: "bank" }, { id: "ag_m", buildingId: "lab" }];

describe("spendByLaneKind (gr_lwgus14rd2 step 1)", () => {
  it("puts manage in manager, other purposes and lane-less work in other, work in its lane", () => {
    expect(laneKindRow({ purpose: "manage", lane: null }, "grant")).toBe("manager");
    expect(laneKindRow({ purpose: "summary", lane: null }, undefined)).toBe("other");
    expect(laneKindRow({ purpose: "work", lane: null }, undefined)).toBe("other");
    expect(laneKindRow({ purpose: "work", lane: null }, "retainer")).toBe("retainer");
    expect(laneKindRow({ purpose: "work", lane: "directed" }, "grant")).toBe("directed");
  });

  it("prices each kind, sums rows to the window's sessions and gives the cache-write share", () => {
    const sessions = [
      // grant: 1,000 output ($0.02) + 10,000 cache write 1 h ($0.08): share 0.8, 5,000 adj. tokens
      ses({ assignmentId: "a_grant", output: 1_000, cacheWrite1h: 10_000 }),
      // exploration via the assignment's lane, in lab: 100,000 cache read = 1,000 adj. tokens, $0.02, share 0
      ses({ assignmentId: "a_explore", cacheRead: 100_000 }),
      // manager wake, lab (agent's building): 1,000 input = 200 adj., 2,000 cache write 5 min = 500 adj.
      ses({ agentId: "ag_m", purpose: "manage", input: 1_000, cacheWrite5m: 2_000 }),
      // a Haiku subagent inside a grant session: priced at Haiku, converted at Opus output price
      ses({ assignmentId: "a_grant", output: 40_000, byModel: { [HAIKU]: { input: 0, output: 40_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } } }),
      // back-filled (output + cache read at the 30:1 split): not counted
      ses({ purpose: "review", output: 707, cacheRead: 29_293 }),
      // yesterday: only in 7d
      ses({ purpose: "summary", output: 300, startedAt: "2026-11-03T10:00:00.000Z", endedAt: "2026-11-03T10:05:00.000Z" }),
      // nine days ago: in neither
      ses({ output: 999, startedAt: "2026-10-26T10:00:00.000Z", endedAt: "2026-10-26T10:05:00.000Z" }),
      // still running today (no end): counts by its start
      ses({ assignmentId: "a_grant", output: 10, endedAt: null, startedAt: "2026-11-04T17:00:00.000Z" }),
    ];
    const t = spendByLaneKind({ sessions, assignments, agents }, "today", NOW);
    expect(t.from).toBe("2026-11-04T00:00:00.000Z");
    expect(t.rows.map((r) => r.lane)).toEqual(["grant", "exploration", "manager"]);
    const grant = t.rows[0]!;
    expect(grant.sessions).toBe(3);
    expect(grant.kinds.output.tokens).toBe(1_000 + 1_000 + 10); // Haiku 40k output = $0.02 = 1,000 Opus output tokens
    expect(grant.kinds.cacheWrite1h).toEqual({ tokens: 4_000, usd: 0.08 });
    expect(grant.tokens).toBe(6_010);
    expect(grant.cacheWriteShare).toBeCloseTo(0.08 / (0.08 + 0.04 + 0.0002), 3);
    expect(t.rows[1]!.cacheWriteShare).toBe(0);
    const mgr = t.rows[2]!;
    expect(mgr.kinds.input.tokens).toBe(200);
    expect(mgr.kinds.cacheWrite5m.tokens).toBe(500);
    expect(t.notCounted.sessions).toBe(1);
    expect(t.notCounted.tokens).toBe(1_000);
    expect(t.total.tokens).toBe(6_010 + 1_000 + 700);
    expect(t.sessionsTokens).toBe(t.total.tokens + t.notCounted.tokens);
    expect(t.check.ok).toBe(true);
    // per building: bank has the grant rows and the back-filled review; lab has exploration and the manager
    expect(t.buildings.bank!.rows.map((r) => r.lane)).toEqual(["grant"]);
    expect(t.buildings.bank!.notCounted.sessions).toBe(1);
    expect(t.buildings.lab!.rows.map((r) => r.lane)).toEqual(["exploration", "manager"]);

    const week = spendByLaneKind({ sessions, assignments, agents }, "7d", NOW);
    expect(week.from).toBe("2026-10-28T00:00:00.000Z");
    expect(week.rows.find((r) => r.lane === "other")?.tokens).toBe(300);
    expect(week.total.sessions + week.notCounted.sessions).toBe(7);
    expect(week.check.ok).toBe(true);
  });
});
