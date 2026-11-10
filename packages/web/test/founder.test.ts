import { describe, expect, test } from "vitest";
import type { Event, TownHealth } from "@muster-town/schema";
import { founderStale, founderStep } from "../src/founder";

const SINCE = "2026-11-03T02:00:00.000Z";
const health = (founder: TownHealth["founder"], funding: TownHealth["funding"] = "api-key"): TownHealth => ({ docker: true, funding, founder });
const started = { id: 7, ts: SINCE, type: "exploration.started", agentId: "ag_x", buildingId: "bl_w", text: "", payload: {} } as unknown as Event;

describe("the founder's HUD after the key (gr_ngg1z160a8 step 3)", () => {
  test("exploring: an exploration started, nothing proposed or funded", () => {
    expect(founderStep(health({ exploringSince: SINCE, proposals: 0, funded: false }), true, [started])).toEqual({ kind: "exploring", since: SINCE, agentId: "ag_x" });
    expect(founderStep(health({ exploringSince: SINCE, proposals: 0, funded: false }), true, [])).toEqual({ kind: "exploring", since: SINCE, agentId: null });
  });
  test("a proposal open and nothing funded: the proposal is waiting (it wins over exploring)", () => {
    expect(founderStep(health({ exploringSince: SINCE, proposals: 1, funded: false }), true, [started])).toEqual({ kind: "proposal", count: 1 });
  });
  test("any grant funded: nothing, even with another proposal open", () => {
    expect(founderStep(health({ exploringSince: SINCE, proposals: 2, funded: true }), true)).toBeNull();
  });
  test("no key, not the admin, no exploration yet, or not hosted (the Workshop): nothing", () => {
    expect(founderStep(health({ exploringSince: SINCE, proposals: 1, funded: false }, "none"), true)).toBeNull();
    expect(founderStep(health({ exploringSince: SINCE, proposals: 1, funded: false }), false)).toBeNull();
    expect(founderStep(health({ exploringSince: null, proposals: 0, funded: false }), true)).toBeNull();
    expect(founderStep({ docker: true }, true)).toBeNull();
    expect(founderStep(null, true)).toBeNull();
  });
  test("refetches health on a key, an exploration, or a grant decision; not on chatter", () => {
    for (const t of ["bank.input", "exploration.started", "grant.proposed", "grant.funded", "grant.rejected"] as const) expect(founderStale({ type: t })).toBe(true);
    expect(founderStale({ type: "agent.said" })).toBe(false);
  });
});
