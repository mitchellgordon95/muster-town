import { describe, expect, it } from "vitest";
import { countersSince, GRANTS_IDENTITY, spendOutcome, createBuilding, createResident, financeSpend, grantTitle, ledgerBookedBeforeConversion, NO_ASSIGNMENT, notFundedUsage, NOT_FUNDED_SPLIT_REASON, NO_BUILDING, NO_GRANT, UNATTRIBUTED, WEIGHT_MISMATCH, type SpendInputs, type SpendNode } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const T0 = new Date("2026-10-28T12:00:00.000Z");
const OPUS = "claude-opus-5-5";
// output-only Opus counters: adjusted tokens = output
const s = (agentId: string, assignmentId: string | null, output: number, grantId: string | null = null) =>
  ({ agentId, assignmentId, grantId, model: OPUS, input: 0, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, byModel: null, endedAt: "2026-10-28T11:00:00.000Z" });

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
  convertedAt: null,
};
const sum = (rows: SpendNode[]) => rows.reduce((t, r) => t + r.tokens, 0);

describe("financeSpend (GET /api/finance/spend)", () => {
  it("is empty with an ok check on an empty town", () => {
    const f = financeSpend({ sessions: [], assignments: [], agents: [], buildings: [], grants: [], convertedAt: null }, 0, T0);
    expect(f).toMatchObject({ used: 0, sessionsTotal: 0, unattributed: 0, weightMismatch: 0, convertedAt: null, notFunded: 0, rows: [], check: { ok: true, diff: 0 } });
  });

  it("splits building → grant → assignment, with a manager row and a no-grant group; usage before counters is unattributed", () => {
    // used 1,500: sessions count 1,150, the rest (350) is pre-counter usage (ag_old's session has zero counters)
    const f = financeSpend(base, 1_500, T0);
    expect(f).toMatchObject({ used: 1_500, sessionsTotal: 1_150, unattributed: 350, notFunded: 0, check: { ok: true, diff: 0 } });
    expect(f.rows.map((r) => [r.kind, r.name, r.tokens])).toEqual([
      ["building", "Bank Transparency", 720],
      ["building", "Lab", 430],
      ["unattributed", UNATTRIBUTED, 350],
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
    // no lane recorded on the sessions: one "Before lanes" row under the bucket (gr_utygatbi85)
    expect(lab.children![0].children!.map((c) => [c.kind, c.id, c.tokens])).toEqual([["lane", "before", 430]]);
    expect(lab.children![0].children![0].children!.map((c) => [c.id, c.tokens, c.sessions])).toEqual([["a4", 430, 2], ["a5", 0, 1]]);
    expect(f.noGrantCheck).toMatchObject({ ok: true, diff: 0 });
    expect(f.noGrant).toMatchObject({ tokens: 480, sessions: 4, byLane: { before: { tokens: 480, sessions: 4, assignments: 3 }, directed: { tokens: 0 } } });
  });

  it("splits 'Not under a grant' by lane; directed rows name source and asker, exploration rows the proposal they ended in (gr_utygatbi85)", () => {
    const at = (h: number, m = 0) => `2026-10-28T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
    const w = (agentId: string, assignmentId: string, output: number, lane: "directed" | "exploration" | "retainer" | "grant" | null, start: number, purpose: "work" | "review" = "work") =>
      ({ ...s(agentId, assignmentId, output), lane, purpose, startedAt: at(start), endedAt: at(start, 30) });
    const inp: SpendInputs = {
      sessions: [
        w("ag_f1", "d1", 100, "directed", 1), w("ag_f1", "d2", 40, "directed", 2), w("ag_f1", "d3", 10, "directed", 2),
        w("ag_f2", "e1", 80, "exploration", 3), w("ag_f2", "e2", 60, "exploration", 5), w("ag_f3", "e3", 20, "exploration", 6),
        w("ag_f1", "r1", 7, "retainer", 7), w("ag_f1", "m1", 5, "directed", 8, "review"), w("ag_f1", "o1", 3, null, 0),
      ],
      assignments: [
        { id: "d1", buildingId: "bank", grantId: null, title: "asked in a 1:1", sourceId: "mt_one", origin: null, createdBy: "ag_nell", createdByKind: "agent" },
        { id: "d2", buildingId: "bank", grantId: null, title: "made by a human", sourceId: null, origin: null, createdBy: "us_mitch", createdByKind: "user" },
        { id: "d3", buildingId: "bank", grantId: null, title: "unknown", sourceId: null, origin: null, createdBy: "ag_nell", createdByKind: "agent" },
        { id: "e1", buildingId: "bank", grantId: null, title: "explore 1" },
        { id: "e2", buildingId: "bank", grantId: null, title: "explore 2", reportId: "dc_rep2" },
        { id: "e3", buildingId: "bank", grantId: null, title: "explore 3" },
        { id: "r1", buildingId: "bank", grantId: null, title: "nightly" },
        { id: "m1", buildingId: "bank", grantId: null, title: "review" },
        { id: "o1", buildingId: "bank", grantId: null, title: "old" },
      ],
      agents: [{ id: "ag_f1", buildingId: "bank" }, { id: "ag_f2", buildingId: "bank" }, { id: "ag_f3", buildingId: "bank" }],
      buildings: [{ id: "bank", name: "Bank" }],
      grants: [
        // filed inside e1's session by its fork: funded, then closed
        { id: "gr_a", objective: "A plan", title: "Plan A", proposedBy: "ag_f2", createdAt: at(3, 20), fundedAt: at(4), status: "closed", outcome: "done" },
        // filed by e2's fork long after its session, but citing its report: rejected
        { id: "gr_b", objective: "B plan", proposedBy: "ag_nell", createdAt: at(9), status: "rejected", findingsDocIds: ["dc_rep2"] },
        // e3's fork filed nothing; a grant by another agent in the window does not count
        { id: "gr_c", objective: "C plan", proposedBy: "ag_f1", createdAt: at(6, 10), status: "proposed" },
      ],
      users: [{ id: "us_mitch", name: "Mitchell" }, { id: "us_ann", name: "Ann" }],
      sourceAskers: new Map([["mt_one", "us_ann"]]),
      convertedAt: null,
    };
    const f = financeSpend(inp, 325, T0);
    const ng = f.rows[0].children!.find((c) => c.kind === "no-grant")!;
    expect(ng.tokens).toBe(325);
    expect(ng.children!.map((c) => [c.lane, c.tokens, c.sessions])).toEqual([["exploration", 160, 3], ["directed", 150, 3], ["retainer", 7, 1], ["manager", 5, 1], ["before", 3, 1]]);
    const kid = (lane: string, id: string) => ng.children!.find((c) => c.lane === lane)!.children!.find((c) => c.id === id)!;
    expect(kid("directed", "d1").source).toEqual({ id: "mt_one", kind: "meeting", askedById: "us_ann", askedBy: "Ann" });
    expect(kid("directed", "d2").source).toEqual({ id: null, kind: null, askedById: "us_mitch", askedBy: "Mitchell" });
    expect(kid("directed", "d3").source).toEqual({ id: null, kind: null, askedById: null, askedBy: null });
    expect(kid("exploration", "e1").proposal).toEqual({ id: "gr_a", title: "Plan A", state: "funded" });
    expect(kid("exploration", "e2").proposal).toMatchObject({ id: "gr_b", state: "rejected" });
    expect(kid("exploration", "e3").proposal).toBeNull();
    expect(f.noGrant.exploration).toEqual({ assignments: 3, proposals: 2, funded: 1, rejected: 1, withdrawn: 0, open: 0 });
    expect(f.noGrant.directed).toEqual({ assignments: 3, withSource: 1, withAsker: 2 });
    expect(f.noGrantCheck).toMatchObject({ ok: true, diff: 0 });
  });

  it("session spend beyond used gets a negative 'not funded' row, so the rows still sum to used", () => {
    const f = financeSpend({ ...base, sessions: [...base.sessions, s("ag_librarian", null, 250)], agents: [...base.agents, { id: "ag_librarian", buildingId: null }] }, 1_000, T0);
    expect(f).toMatchObject({ sessionsTotal: 1_400, unattributed: 0, notFunded: 400, check: { ok: true, diff: 0 } });
    expect(f.rows.at(-1)).toMatchObject({ kind: "not-funded", tokens: -400, share: -0.4 });
    expect(f.rows.find((r) => r.id === null && r.kind === "building")).toMatchObject({ name: NO_BUILDING, tokens: 250 });
    expect(sum(f.rows)).toBe(1_000);
  });

  it("takes the pre-conversion weight mismatch off as its own row: sessions ended before bank.converted priced at their model vs the ledger's Opus weights", () => {
    const CONVERTED = "2026-10-27T00:00:24.000Z", FABLE = "claude-fable-5-1";
    // earlier: back-filled by migration 034; before: the runtime writes counters (first real-counter session); after: converted
    const earlier = "2026-10-26T06:00:00.000Z", before = "2026-10-26T12:00:00.000Z", between = "2026-10-26T18:00:00.000Z", after = "2026-10-27T12:00:00.000Z";
    const fable = (counts: Partial<Record<"output" | "cacheRead", number>>, endedAt: string | null) =>
      ({ agentId: "ag_lab", assignmentId: "a4", grantId: null, model: FABLE, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, byModel: null, endedAt, ...counts });
    // back-filled by migration 034 (only a raw total, 24,000): split at the Fable ratio → 1,000 here; the ledger split it at the Opus ratio → 800
    const backfilled = fable({ output: 884, cacheRead: 23_116 }, earlier);
    expect(ledgerBookedBeforeConversion(backfilled, before)).toBe(800);
    expect(ledgerBookedBeforeConversion(backfilled, null)).toBe(800); // no real counters anywhere: everything is a migration back-fill
    // real counters: Fable's cache-read weight 0.005 → 1,100 here; migration 037 booked the ledger row at Opus's 0.01 → 1,200
    const real = fable({ output: 1_000, cacheRead: 20_000 }, before);
    expect(ledgerBookedBeforeConversion(real, before)).toBe(1_200);
    // a bare total the runtime split itself at the Fable ratio (raw 12,000 → 500 here) after counters began: the ledger
    // got the same split and priced it at Opus weights → 558, not raw/30 = 400
    const runtimeSplit = fable({ output: 442, cacheRead: 11_558 }, between);
    expect(ledgerBookedBeforeConversion(runtimeSplit, before)).toBe(558);
    const sessions = [
      backfilled, real, runtimeSplit,
      { ...s("ag_lab", "a4", 707), cacheRead: 29_293, endedAt: earlier }, // back-filled Opus (raw 30,000): 1,000 on both sides
      fable({ output: 884, cacheRead: 23_116 }, after), // after the conversion: priced the same way on both sides
      fable({ output: 884, cacheRead: 23_116 }, null), // never ended: not pre-conversion
    ];
    const inp: SpendInputs = { ...base, sessions, convertedAt: CONVERTED };
    expect(countersSince(sessions)).toBe(before);
    // sessions 5,600; the ledger booked 5,558 for them (mismatch +200 − 100 − 58 = +42 over 3 sessions); used 4,900 → 658 not funded
    const f = financeSpend(inp, 4_900, T0);
    expect(f).toMatchObject({ used: 4_900, sessionsTotal: 5_600, weightMismatch: 42, unattributed: 0, notFunded: 658, convertedAt: CONVERTED, check: { ok: true, diff: 0, identity: "buildings + unattributed − weight mismatch − not funded = used" } });
    expect(f.rows.map((r) => [r.kind, r.tokens, r.sessions])).toEqual([["building", 5_600, 6], ["weight-mismatch", -42, 3], ["not-funded", -658, 0]]);
    expect(f.rows[1].name).toBe(WEIGHT_MISMATCH);
    expect(f.weightMismatchNote).toContain("2026-10-27 00:00Z");
    expect(sum(f.rows)).toBe(4_900);
    // used 5,608: the ledger booked 5,558, so 50 is unattributed, and the mismatch row still comes off
    const g = financeSpend(inp, 5_608, T0);
    expect(g).toMatchObject({ unattributed: 50, weightMismatch: 42, notFunded: 0, check: { ok: true, diff: 0 } });
    expect(g.rows.map((r) => [r.kind, r.tokens])).toEqual([["building", 5_600], ["unattributed", 50], ["weight-mismatch", -42]]);
    expect(sum(g.rows)).toBe(5_608);
    // a Bank born adjusted (no bank.converted event): no mismatch, the whole gap is not funded
    const h = financeSpend({ ...inp, convertedAt: null }, 4_900, T0);
    expect(h).toMatchObject({ weightMismatch: 0, notFunded: 700, check: { ok: true, diff: 0 } });
    expect(h.rows.map((r) => r.kind)).toEqual(["building", "not-funded"]);
  });

  it("splits 'not funded' by building from usage rows with no debit for the same agent within 2 s (dc_cvp89lj91o)", () => {
    const at = (iso: string, ms = 0) => new Date(Date.parse(iso) + ms).toISOString();
    const D0 = "2026-10-29T10:00:00.000Z";
    const u = (agentId: string, buildingId: string | null, tokens: number, createdAt: string) => ({ agentId, buildingId, tokens, createdAt });
    const usage = [
      u("ag_asha", "bank", 999, at(D0, -60_000)), // before the first debit: ignored
      u("ag_asha", "bank", 300, at(D0, 10_000)), // debit 0.35 s later: paid
      u("ag_asha", "bank", 100, at(D0, 20_000)), // nearest debit 5 s away: unpaid
      u("ag_asha", "bank", 50, at(D0, 30_000)), // only another agent's debit at the same time: unpaid
      u("ag_lab", "lab", 70, at(D0, 40_000)), // no debit at all: unpaid
      u("ag_lab", "lab", 30, "2026-10-30T23:59:00.000Z"), // the last unpaid row
      u("ag_librarian", null, 0, at(D0, 50_000)), // no building: the unattributed row
    ];
    const debits = [
      { agentId: "ag_asha", createdAt: D0 },
      { agentId: "ag_asha", createdAt: at(D0, 10_350) },
      { agentId: "ag_asha", createdAt: at(D0, 25_000) },
      { agentId: "ag_nell", createdAt: at(D0, 30_000) },
    ];
    // a donation to Lab spent 60 (no Bank debit): it paid 60 of Lab's 100 undebited, so the split counts 40
    const allocations = [{ buildingId: "lab", spentTokens: 60 }, { buildingId: "elsewhere", spentTokens: 500 }];
    // sessions 1,150 vs used 960: notFunded 190, and the split sums to it
    const f = financeSpend({ ...base, usage, debits, allocations }, 960, T0);
    expect(f).toMatchObject({ notFunded: 190, check: { ok: true, diff: 0 }, notFundedLastAt: "2026-10-30T23:59:00.000Z", notFundedAllocationPaid: 60, notFundedSplitCheck: { sum: 190, notFunded: 190, ok: true } });
    expect(f.notFundedSplitCheck.reason).toBeUndefined();
    expect(f.notFundedSplit).toEqual([
      { buildingId: "bank", buildingName: "Bank Transparency", usageRows: 2, tokens: 150 },
      { buildingId: "lab", buildingName: "Lab", usageRows: 2, tokens: 40 },
      { buildingId: null, buildingName: "unattributed", usageRows: 1, tokens: 0 },
    ]);
    // the ledger number stays exact and untouched: a split that differs is shown, not fudged
    const g = financeSpend({ ...base, usage, debits, allocations }, 1_000, T0);
    expect(g).toMatchObject({ notFunded: 150, check: { ok: true, diff: 0 }, notFundedSplitCheck: { sum: 190, notFunded: 150, ok: false, reason: NOT_FUNDED_SPLIT_REASON } });
    // a donation larger than the building's undebited usage pays at most that usage, and the building drops out
    const all = notFundedUsage({ usage, debits, allocations: [{ buildingId: "lab", spentTokens: 1_000 }], buildings: base.buildings });
    expect(all.allocationPaid).toBe(100);
    expect(all.split.map((x) => x.buildingId)).toEqual(["bank", null]);
    // no ledgers: an empty split that matches a zero notFunded
    expect(financeSpend(base, 1_500, T0)).toMatchObject({ notFundedSplit: [], notFundedLastAt: null, notFundedAllocationPaid: 0, notFundedSplitCheck: { sum: 0, notFunded: 0, ok: true } });
  });

  it("names a grant row by its title (else its objective's first clause, no ellipsis) and carries the full objective", () => {
    const long = "A stranger can read the Bank page: every term defined on the page or in one linked glossary";
    const f = financeSpend({ ...base, grants: [{ id: "g1", objective: long }] }, 1_500, T0);
    expect(f.rows[0].children![0]).toMatchObject({ kind: "grant", id: "g1", name: "A stranger can read the Bank page", objective: long });
    expect(f.rows[0].children![1]).not.toHaveProperty("objective");
    expect(grantTitle("Spend breakdown")).toBe("Spend breakdown");
    expect(grantTitle("Users can review, at a glance")).toBe("Users can review…");
    const cut = grantTitle("Every Bank row and every grant row reads as a plain sentence that a stranger understands");
    expect(cut).toBe("Every Bank row and every grant row reads as a plain…");
    expect(cut.length).toBeLessThanOrEqual(60);
  });

  it("grant rows carry funding, status, outcome and key results; the grants block sums them by outcome, a grant in two buildings counted once (gr_dt1l35tydx)", () => {
    const inp: SpendInputs = {
      ...base,
      sessions: [...base.sessions, s("ag_lab", "a6", 250, "g1"), s("ag_lab", "a7", 90, "g2"), s("ag_lab", "a8", 40, "g3"), s("ag_lab", "a9", 5, "gx")],
      assignments: [...base.assignments, { id: "a6", buildingId: "lab", grantId: "g1", title: "lab side of g1" }, { id: "a7", buildingId: "lab", grantId: "g2", title: "cut work" }, { id: "a8", buildingId: "lab", grantId: "g3", title: "open work" }, { id: "a9", buildingId: "lab", grantId: "gx", title: "unknown grant" }],
      grants: [
        { id: "g1", objective: "Spend breakdown", grantTokens: 700, status: "closed", outcome: "done" },
        { id: "g2", objective: "Cut thing", grantTokens: 50, status: "closed", outcome: "cut" },
        { id: "g3", objective: "Open thing", grantTokens: 100, status: "checkpoint", outcome: null },
      ],
      keyResults: [{ grantId: "g1", status: "met" }, { grantId: "g1", status: "claimed" }, { grantId: "g2", status: "missed" }, { grantId: "g3", status: "on-track" }, { grantId: null, status: "met" }],
    };
    const f = financeSpend(inp, 1_885, T0);
    expect(f.check.ok).toBe(true);
    const bankG1 = f.rows.find((r) => r.id === "bank")!.children!.find((c) => c.id === "g1")!;
    expect(bankG1).toMatchObject({ grantTokens: 700, status: "closed", outcome: "done", outcomeGroup: "done", krCounts: { met: 1, missed: 0, claimed: 1, open: 0 }, tokens: 600 });
    const lab = f.rows.find((r) => r.id === "lab")!.children!;
    expect(lab.find((c) => c.id === "g3")).toMatchObject({ status: "checkpoint", outcome: null, outcomeGroup: "open", krCounts: { met: 0, missed: 0, claimed: 0, open: 1 } });
    // an unknown grant keeps its bare row, no grant fields, and is left out of the block
    const gx = lab.find((c) => c.id === "gx")!;
    expect(gx.name).toBe("gx");
    for (const k of ["grantTokens", "status", "outcome", "outcomeGroup", "krCounts"]) expect(gx).not.toHaveProperty(k);
    // g1: 600 (Bank) + 250 (Lab) = 850 of 700, over by 150; g2: 90 of 50, over by 40
    expect(f.grants).toEqual({
      count: 3, funded: 850, spent: 980,
      byOutcome: { done: { count: 1, tokens: 850 }, cut: { count: 1, tokens: 90 }, open: { count: 1, tokens: 40 } },
      overFunding: { count: 2, tokens: 190 },
      // none of these grants carries a cost estimate (grant-estimate.test.ts counts them)
      estimates: { closed: 0, inside: 0, unit: "adjusted tokens", badRanges: [] },
    });
    expect(f.grantsCheck).toEqual({ ok: true, diff: 0, identity: GRANTS_IDENTITY });
  });

  it("maps a grant's status and outcome to done, cut or still open", () => {
    expect(spendOutcome({ status: "closed", outcome: "done" })).toBe("done");
    expect(spendOutcome({ status: "closed", outcome: "met" })).toBe("done");
    for (const o of ["cut", "stopped", "spent"] as const) expect(spendOutcome({ status: "closed", outcome: o })).toBe("cut");
    expect(spendOutcome({ status: "rejected", outcome: null })).toBe("cut");
    for (const st of ["funded", "checkpoint", "proposed", "draft", "countered"] as const) expect(spendOutcome({ status: st, outcome: null })).toBe("open");
  });

  it("an empty grants block when no grant is known, with an ok check", () => {
    const f = financeSpend(base, 1_500, T0);
    expect(f.grants).toMatchObject({ count: 0, spent: 0, funded: 0 });
    expect(f.grantsCheck.ok).toBe(true);
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
    // dollars (gr_gmzli3f96j): the 800 Opus-booked tokens at $20/M, the same used dollars on both endpoints, the rows close
    expect(f.rows.find((r) => r.id === b.id)!.usd).toBe(0.02);
    expect(f.usd.used).toBe(world.bank.finance(T0).usd.used);
    expect(f.usdSumCheck.ok).toBe(true);
  });
});
