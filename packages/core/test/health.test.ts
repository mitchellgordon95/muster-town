import { splitRaw } from "@muster-town/schema";
import { describe, expect, it } from "vitest";
import { sessionTokens } from "../src/bank.ts";
import { grantHolds, healthLine, healthOf, isoWeekStart, townHealth, type HealthInputs } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

// Town health (gr_8bxoy2heif): each metric's definition over hand-made sessions.
const M = "claude-opus-5-5";
const NOW = new Date("2026-11-10T20:00:00.000Z");
let seq = 0;
function sess(o: Partial<HealthInputs["sessions"][number]> = {}): HealthInputs["sessions"][number] {
  return {
    id: `se_${++seq}`, assignmentId: null, purpose: "work", lane: "grant", grantId: null, reportId: null, model: M, bankModel: M, byModel: null,
    startedAt: "2026-11-10T10:00:00.000Z", endedAt: "2026-11-10T11:00:00.000Z",
    input: 1000, output: 1000, cacheRead: 8000, cacheWrite5m: 2000, cacheWrite1h: 0, ...o,
  };
}
const tk = (s: HealthInputs["sessions"][number]) => sessionTokens(s);

describe("town health", () => {
  it("paperwork = kickoff + checkpoint + manager wakes ÷ (grant lane ∪ those); other lanes stay out of both", () => {
    const work = sess({ assignmentId: "as_w" });
    const kick = sess({ assignmentId: "as_k", lane: "grant" });
    const check = sess({ assignmentId: "as_c", lane: "directed" });
    const wake = sess({ purpose: "manage", lane: null });
    const review = sess({ purpose: "review", lane: null });
    const explore = sess({ lane: "exploration" });
    const h = healthOf({
      sessions: [work, kick, check, wake, review, explore],
      assignments: [
        { id: "as_w", title: "Step 1: build it", lane: "grant" },
        { id: "as_k", title: "Grant \"X\" funded: assign its first step", lane: "grant" },
        { id: "as_c", title: "Write the checkpoint for \"X\"", lane: "directed" },
      ],
      holds: [],
    }, NOW);
    const l = h.last24h;
    const paper = tk(kick) + tk(check) + tk(wake) + tk(review);
    expect(l.paperworkTokens).toBe(Math.round(paper));
    expect(l.paperworkShare).toBeCloseTo(paper / (paper + tk(work)), 3);
    expect(l.sessions).toBe(6);
    expect(h.days.at(-1)!.day).toBe("2026-11-10");
    expect(h.days.at(-1)!.paperworkShare).toBe(l.paperworkShare);
    expect(healthLine(h)).toMatch(/^Health: paperwork \d+% · cache hits 80% · overrun 0 · .+\/report \(last 24 h\)$/);
  });

  it("cache hit ratio is raw reads ÷ (reads + both writes); the median write is per session", () => {
    const h = healthOf({
      sessions: [
        sess({ cacheRead: 9000, cacheWrite5m: 500, cacheWrite1h: 500 }),
        sess({ cacheRead: 1000, cacheWrite5m: 3000, cacheWrite1h: 1000 }),
        sess({ cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }),
      ],
      assignments: [], holds: [],
    }, NOW);
    expect(h.last24h.cacheRead).toBe(10_000);
    expect(h.last24h.cacheWrite).toBe(5000);
    expect(h.last24h.hitRatio).toBeCloseTo(2 / 3, 3);
    expect(h.last24h.medianCacheWrite).toBe(1000);
  });

  it("overrun counts a grant's sessions started inside its hold only, and an open hold runs to now", () => {
    const before = sess({ grantId: "gr_a", startedAt: "2026-11-10T08:00:00.000Z", endedAt: "2026-11-10T09:30:00.000Z" });
    const inside = sess({ grantId: "gr_a", startedAt: "2026-11-10T09:10:00.000Z" });
    const after = sess({ grantId: "gr_a", startedAt: "2026-11-10T12:00:00.000Z", endedAt: "2026-11-10T13:00:00.000Z" });
    const other = sess({ grantId: "gr_b", startedAt: "2026-11-10T09:10:00.000Z" });
    const open = sess({ grantId: "gr_c", startedAt: "2026-11-10T15:00:00.000Z", endedAt: "2026-11-10T16:00:00.000Z" });
    const h = healthOf({
      sessions: [before, inside, after, other, open], assignments: [],
      holds: [{ grantId: "gr_a", from: "2026-11-10T09:00:00.000Z", to: "2026-11-10T11:30:00.000Z" }, { grantId: "gr_c", from: "2026-11-10T14:00:00.000Z", to: null }],
    }, NOW);
    expect(h.last24h.overrunTokens).toBe(Math.round(tk(inside) + tk(open)));
  });

  it("leaves back-filled sessions out and counts them apart; tokens per report by lane", () => {
    const back = sess({ ...splitRaw(50_000, M), reportId: "dc_x" });
    const g1 = sess({ reportId: "dc_1" }), g2 = sess({}), d1 = sess({ lane: "directed", reportId: "dc_2" });
    const h = healthOf({ sessions: [back, g1, g2, d1], assignments: [], holds: [] }, NOW);
    expect(h.notCounted.sessions).toBe(1);
    expect(h.last24h.sessions).toBe(3);
    expect(h.last24h.byLane.grant).toEqual({ tokens: Math.round(tk(g1) + tk(g2)), reports: 1, perReport: Math.round(tk(g1) + tk(g2)) });
    expect(h.last24h.byLane.directed!.reports).toBe(1);
    expect(h.last24h.reports).toBe(2);
  });

  it("buckets by UTC day and ISO week; a session outside the window is not counted", () => {
    const old = sess({ startedAt: "2026-09-01T10:00:00.000Z", endedAt: "2026-09-01T11:00:00.000Z" });
    const lastWeek = sess({ startedAt: "2026-11-08T10:00:00.000Z", endedAt: "2026-11-08T11:00:00.000Z" }); // a Sunday
    const h = healthOf({ sessions: [old, lastWeek], assignments: [], holds: [] }, NOW);
    expect(h.days).toHaveLength(14);
    expect(h.weeks.map((w) => w.week)).toEqual(["2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"]);
    expect(h.weeks.find((w) => w.week === "2026-11-02")!.sessions).toBe(1);
    expect(h.days.find((d) => d.day === "2026-11-08")!.sessions).toBe(1);
    expect(h.last24h.sessions).toBe(0);
    expect(isoWeekStart(Date.parse("2026-11-09T00:00:00Z"))).toBe("2026-11-09");
  });

  it("reads a grant's holds off the event log: a checkpoint until the next funded or closed", () => {
    const { world } = seededWorld();
    world.events.append({ type: "grant.checkpoint", buildingId: null, text: "hold", payload: { grantId: "gr_h" } });
    world.events.append({ type: "grant.funded", buildingId: null, text: "Continued", payload: { grantId: "gr_h" } });
    world.events.append({ type: "grant.checkpoint", buildingId: null, text: "hold again", payload: { grantId: "gr_h" } });
    const holds = grantHolds(world).filter((h) => h.grantId === "gr_h");
    expect(holds).toHaveLength(2);
    expect(holds[0]!.to).not.toBeNull();
    expect(holds[1]!.to).toBeNull();
    const h = townHealth(world);
    expect(h.days).toHaveLength(14);
    expect(JSON.stringify(h)).not.toMatch(/"(ag|us)_/);
  });
});
