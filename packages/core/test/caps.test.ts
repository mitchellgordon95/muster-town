import { describe, expect, it } from "vitest";
import type { Event, TokenCounts } from "@muster-town/schema";
import { createBuilding, createResident } from "../src/index.ts";
import { countDeaths } from "../src/caps.ts";
import { utcDay } from "../src/drift.ts";
import { seededWorld } from "./helpers.ts";

// Bank grant step 5: unexpected out-of-tokens deaths over 7 days. The learned-cap hold is gone (2026-11-01): a cap event never holds starts.
const NOW = new Date("2026-10-26T23:00:00.000Z");
let id = 0;
const ev = (type: Event["type"], ts: string, text: string, payload: Record<string, unknown> = {}, agentId = "ag_x"): Event =>
  ({ id: ++id, ts, type, agentId, buildingId: "lab", text, payload }) as Event;
const CAP_MSG = "You've hit your org's monthly spend limit · resets 8:50pm (UTC)";

describe("countDeaths (Bank grant step 5)", () => {
  it("baseline week: 3 cap deaths + 4 budget.exhausted = 7; one death per session; old and look-alike events left out", () => {
    const evs = [
      // cap deaths: a bank.cap and its session.ended name the same session (one death); an old-style echoed thought; a bare SPEND_LIMIT error
      ev("bank.cap", "2026-10-25T22:18:00.000Z", "Kelly hit the subscription cap", { sessionId: "se_1" }),
      ev("session.ended", "2026-10-25T22:18:01.000Z", "Kelly's work session ended (error)", { sessionId: "se_1", error: CAP_MSG }),
      ev("agent.thought", "2026-10-24T23:57:00.000Z", CAP_MSG, { sessionId: "se_2" }),
      ev("session.ended", "2026-10-22T10:00:00.000Z", "Root's work session ended (error)", { sessionId: "se_3", error: "usage limit reached" }),
      // budget.exhausted: every event counts (old agent-daily ones and building)
      ...[20, 21, 25, 26].map((d) => ev("budget.exhausted", `2026-10-${d}T12:00:00.000Z`, "Lab has run out of budget", { scope: d % 2 ? "building" : "agent" })),
      // not deaths: older than 7 days, an ordinary error, Pix's own thought about the limit
      ev("bank.cap", "2026-10-19T22:00:00.000Z", "old cap", { sessionId: "se_old" }),
      ev("session.ended", "2026-10-25T01:00:00.000Z", "x ended (error)", { sessionId: "se_4", error: "tool crashed" }),
      ev("agent.thought", "2026-10-25T02:00:00.000Z", "Kelly hit the monthly spend limit again; I'll hold her queue", { sessionId: "se_5" }),
    ];
    const d = countDeaths(evs, NOW);
    expect(d).toMatchObject({ since: "2026-10-19T23:00:00.000Z", capDeaths: 3, exhausted: 4, total: 7 });
    expect(d.events[0].ts).toBe("2026-10-26T12:00:00.000Z");
    expect(d.events.filter((e) => e.kind === "cap").map((e) => e.sessionId).sort()).toEqual(["se_1", "se_2", "se_3"]);
    expect(countDeaths([], NOW).total).toBe(0);
  });
});

describe("no learned cap (2026-11-01)", () => {
  it("a cap event is observed (cappedAt, a death) but holds nothing: the assignment may still start, no bank.hold", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Lab" }, seed.admin.id);
    const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
    // the subscription is the only credential: the exact shape the old hold froze (no fallback key)
    world.bank.addInput(seed.admin.id, { label: "Max plan", source: "subscription", token: "sk-ant-oat01-test-token", model: "claude-opus-5-5", tokens: 5_000_000, recurrence: "daily", weeklyCapTokens: 50_000_000 });
    const counts: TokenCounts = { input: 0, output: 100_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    for (let i = 0; i < 3; i++) {
      const s = world.ops.startSession(a.id, { purpose: "work", model: "claude-opus-5-5" });
      world.ops.endSession(s.id, { status: "done", counts, byModel: { "claude-opus-5-5": counts }, costUsd: 2 });
    }
    const t0 = new Date();
    const none = world.bank.summary();
    expect(none.cap).toMatchObject({ cappedAt: null });
    expect(none.cap).not.toHaveProperty("learnedCap");
    expect(none.cap.spentToday).toBe(300_000);
    expect(none.deaths).toMatchObject({ capDeaths: 0, total: 0 });

    // a cap event at today's spend: the old code learned a 350k daily cap from it and held every subscription start
    world.events.append({ type: "bank.cap", buildingId: b.id, text: "cap", payload: { sessionId: "se_x", day: utcDay(new Date()), subscriptionAdjustedToday: 350_000 } });
    const later = new Date(t0.getTime() + 31_000);
    const st = world.bank.capState(later);
    expect(st.cappedAt).toBeTruthy();
    expect(world.budget.canStart(a.id)).toBe(true);
    expect(world.events.list({ types: ["bank.hold"] })).toHaveLength(0);
    expect(world.bank.deaths(later)).toMatchObject({ capDeaths: 1, total: 1 });
  });
});
