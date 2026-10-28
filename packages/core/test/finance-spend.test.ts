import { describe, expect, it } from "vitest";
import { createBuilding, createResident, financeSpend, NO_ASSIGNMENT, NO_BUILDING, NO_GRANT, type SpendInputs, type SpendNode } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const T0 = new Date("2026-10-28T12:00:00.000Z");
const OPUS = "claude-opus-5-5";
// output-only Opus counters: adjusted tokens = output
const s = (agentId: string, assignmentId: string | null, output: number, grantId: string | null = null) =>
  ({ agentId, assignmentId, grantId, model: OPUS, input: 0, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, byModel: null });

// two buildings: Bank (grant g1 with assignments a1, a2; an exploration assignment a3; a manager session) and Lab
const base: SpendInputs = {
  sessions: [
    s("ag_asha", "a1", 300, "g1"),
    s("ag_asha", "a1", 200, "g1"),
    s("ag_asha", "a2", 100), // grant from the assignment
    s("ag_asha", "a3", 50),
    s("ag_nell", null, 70), // manager session, no assignment: the agent's building
    s("ag_lab", "a4", 400),
    s("ag_asha", "a4", 30), // building from the assignment, not the agent
    s("ag_old", "a5", 0), // pre-counter session: zero counters
  ],
  assignments: [
    { id: "a1", buildingId: "bank", grantId: "g1", title: "step 1" },
    { id: "a2", buildingId: "bank", grantId: "g1", title: "step 2" },
    { id: "a3", buildingId: "bank", grantId: null, title: "explore" },
    { id: "a4", buildingId: "lab", grantId: null, title: "lab work" },
    { id: "a5", buildingId: "lab", grantId: null, title: "old work" },
  ],
  agents: [{ id: "ag_asha", buildingId: "bank" }, { id: "ag_nell", buildingId: "bank" }, { id: "ag_lab", buildingId: "lab" }, { id: "ag_old", buildingId: "lab" }],
  buildings: [{ id: "bank", name: "Bank Transparency" }, { id: "lab", name: "Lab" }],
  grants: [{ id: "g1", objective: "Spend breakdown" }],
};
const sum = (rows: SpendNode[]) => rows.reduce((t, r) => t + r.tokens, 0);

describe("financeSpend (GET /api/finance/spend)", () => {
  it("is empty with an ok check on an empty town", () => {
    const f = financeSpend({ sessions: [], assignments: [], agents: [], buildings: [], grants: [] }, 0, T0);
    expect(f).toMatchObject({ used: 0, sessionsTotal: 0, unattributed: 0, notFunded: 0, rows: [], check: { ok: true, diff: 0 } });
  });

  it("splits building → grant → assignment, with a manager row and a no-grant group; usage before counters is unattributed", () => {
    // used 1,500: sessions count 1,150, the rest (350) is pre-counter usage (ag_old's session has zero counters)
    const f = financeSpend(base, 1_500, T0);
    expect(f).toMatchObject({ used: 1_500, sessionsTotal: 1_150, unattributed: 350, notFunded: 0, check: { ok: true, diff: 0 } });
    expect(f.rows.map((r) => [r.kind, r.name, r.tokens])).toEqual([
      ["building", "Bank Transparency", 720],
      ["building", "Lab", 430],
      ["unattributed", expect.stringContaining("Unattributed"), 350],
    ]);
    expect(sum(f.rows)).toBe(f.used);

    const bank = f.rows[0];
    expect(bank.children!.map((c) => [c.kind, c.id, c.name, c.tokens, c.sessions])).toEqual([
      ["grant", "g1", "Spend breakdown", 600, 3],
      ["no-assignment", null, NO_ASSIGNMENT, 70, 1],
      ["no-grant", null, NO_GRANT, 50, 1],
    ]);
    expect(bank.children![0].children!.map((c) => [c.id, c.name, c.tokens, c.share])).toEqual([["a1", "step 1", 500, 0.3333], ["a2", "step 2", 100, 0.0667]]);
    expect(bank.children![1].children).toBeUndefined();
    // every node's children sum to it
    const walk = (n: SpendNode): void => { if (n.children) { expect(sum(n.children)).toBe(n.tokens); n.children.forEach(walk); } };
    f.rows.forEach(walk);

    const lab = f.rows[1];
    expect(lab.children).toEqual([expect.objectContaining({ kind: "no-grant", tokens: 430, sessions: 3 })]);
    expect(lab.children![0].children!.map((c) => [c.id, c.tokens, c.sessions])).toEqual([["a4", 430, 2], ["a5", 0, 1]]);
  });

  it("session spend beyond used gets a negative 'not funded' row, so the rows still sum to used", () => {
    const f = financeSpend({ ...base, sessions: [...base.sessions, s("ag_librarian", null, 250)], agents: [...base.agents, { id: "ag_librarian", buildingId: null }] }, 1_000, T0);
    expect(f).toMatchObject({ sessionsTotal: 1_400, unattributed: 0, notFunded: 400, check: { ok: true, diff: 0 } });
    expect(f.rows.at(-1)).toMatchObject({ kind: "not-funded", tokens: -400, share: -0.4 });
    expect(f.rows.find((r) => r.id === null && r.kind === "building")).toMatchObject({ name: NO_BUILDING, tokens: 250 });
    expect(sum(f.rows)).toBe(1_000);
  });

  it("balances on a real world: sessions booked through the Bank sum with the unattributed row to used", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Lab" }, seed.admin.id);
    const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
    const s1 = world.ops.startSession(a.id, { purpose: "manage", model: OPUS });
    world.ops.endSession(s1.id, { status: "done", counts: { input: 1_000, output: 500, cacheRead: 10_000, cacheWrite5m: 0, cacheWrite1h: 0 } });
    const f = world.bank.spend(T0);
    expect(f.used).toBe(world.bank.finance(T0).used);
    expect(f.check).toMatchObject({ ok: true, diff: 0 });
    expect(sum(f.rows)).toBe(f.used);
    expect(f.rows.find((r) => r.id === b.id)!.children).toEqual([expect.objectContaining({ kind: "no-assignment", tokens: 800, sessions: 1 })]);
  });
});
