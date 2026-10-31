import { describe, expect, it } from "vitest";
import { buildingRoleId, createAssignment, createBuilding, keyResultsBlock, newId, nextStartable, nowIso, sessionMemory, workSystemPrompt } from "../src/index.ts";
import { laneBlock, resolveLane } from "../src/lanes.ts";
import { BUDGET_POLICY } from "../src/policy.ts";
import { creditBank, fundGoalOf, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const KRS = [
  { text: "A visitor can see today's spend on the banner", howToCheck: "Open the lab banner, read Usage" },
  { text: "The board shows the lab's goal first", howToCheck: "Open the lab board" },
];
const REPORT = "## What I did\nx\n## Findings\ny\n## What I need from you\nNothing needed.";

/** Mei manages the lab (manager agent + role), Noor is a resident. Every lab is lane-gated. */
function setup() {
  const s = seededWorld();
  const { world, by, admin } = s;
  const mei = by("Mei"), noor = by("Noor");
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
  /** a grant of the lab with its own key results (default the first of KRS), proposed and funded */
  const fund = (tokens = 4_000_000, keyResults = [KRS[0]!]) => {
    const g = world.grantDesk.propose(mei, world.grantDesk.create(mei, LAB, { keyResults, objective: "Visitors can tell what the lab is for", stopCondition: "two failed tries", askTokens: tokens }).id);
    return world.grantDesk.decide(admin, g.id, { action: "fund" });
  };
  /** a finished session that spent `tokens` in a lane (what a grant's spend is derived from) */
  const spend = (agentId: string, tokens: number, lane: "grant" | "exploration", grantId: string | null = null) => world.sessions.upsert({
    id: newId("se"), agentId, assignmentId: null, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
    sdkSessionId: null, output: tokens, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane, grantId,
  });
  return { ...s, mei, noor, fund, spend };
}

describe("goal-directed budgets: lanes on assignments", () => {
  it("every lab is lane-gated, even one created without budgetMode or with a stale open row; the Town Hall never is", () => {
    const { world, seed, mei } = setup();
    const agent = { kind: "agent" as const, id: mei.id };
    const fresh = createBuilding(world, { name: "Fresh lab" }, seed.admin.id);
    expect(() => resolveLane(world, fresh.id, agent, undefined)).toThrow(/goal-directed.*agents can't create directed work/);
    world.buildings.upsert({ ...world.buildings.require(fresh.id), budgetMode: "open" }); // nothing reads the column any more
    expect(() => resolveLane(world, fresh.id, agent, undefined)).toThrow(/agents can't create directed work/);
    const hall = world.buildings.first("kind = 'town-hall'")!;
    expect(resolveLane(world, hall.id, agent, undefined)).toMatchObject({ lane: "directed", grantId: null, keyResultId: null, gap: null, sourceId: null });
  });

  it("goal-directed: agents must say grant or exploration; fields are validated; humans may still create directed work", async () => {
    const { world, mei, noor, admin, fund } = setup();
    const g = fund();
    const other = world.grantDesk.create(mei, LAB, { keyResults: [KRS[1]!], objective: "other", stopCondition: "s", askTokens: 1 });
    const base = { agentId: mei.id, title: "t", description: "d" };
    await expect(world.verbs.assign(mei, base)).rejects.toThrow(/goal-directed.*agents can't create directed work/);
    await expect(world.verbs.assign(mei, { ...base, lane: "directed" })).rejects.toThrow(/goal-directed/);
    await expect(world.verbs.assign(mei, { ...base, lane: "exploration" })).rejects.toThrow(/names a goal gap/);
    await expect(world.verbs.assign(mei, { ...base, lane: "grant" })).rejects.toThrow(/names its grant/);
    await expect(world.verbs.assign(mei, { ...base, lane: "grant", grantId: other.id })).rejects.toThrow(/draft/);
    // exploration names a gap, never a key result (key results belong to grants)
    await expect(world.verbs.assign(mei, { ...base, lane: "exploration", gap: "  " })).rejects.toThrow(/names a goal gap/);
    const ex = await world.verbs.assign(mei, { ...base, gap: "A visitor can't tell what the lab is for" });
    expect(world.assignments.require(ex.assignmentId)).toMatchObject({ lane: "exploration", gap: "A visitor can't tell what the lab is for", keyResultId: null });
    const gr = await world.verbs.assign(mei, { ...base, lane: "grant", grantId: g.id });
    expect(world.assignments.require(gr.assignmentId)).toMatchObject({ lane: "grant", grantId: g.id, keyResultId: g.keyResultId });
    // POST /api/agents/:id/work by a human: directed bypasses grants (open question 2's default)
    expect(BUDGET_POLICY.directedBypassesGrants).toBe(true);
    expect(world.ops.createWork(admin, noor.id, { title: "fix the banner" }).lane).toBe("directed");
    expect(world.ops.createWork(admin, noor.id, { title: "kr work", lane: "grant", grantId: g.id })).toMatchObject({ lane: "grant", grantId: g.id, keyResultId: g.keyResultId });
    // a continuation inherits its lane (no fields needed)
    const cont = createAssignment(world, { agentId: noor.id, title: "c", description: "d", createdBy: world.holderOf(mei), fromAssignmentId: gr.assignmentId });
    expect(cont).toMatchObject({ lane: "grant", grantId: g.id, keyResultId: g.keyResultId });
  });

  it("a grant assignment can't name a closed, rejected or draft grant; proposed, funded and checkpoint ones are accepted (and the gate holds the unfunded)", async () => {
    const { world, mei, noor, admin, fund } = setup();
    const base = { agentId: mei.id, title: "t", description: "d", lane: "grant" as const };
    const draft = world.grantDesk.create(mei, LAB, { keyResults: [KRS[1]!], objective: "o", stopCondition: "s", askTokens: 1 });
    await expect(world.verbs.assign(mei, { ...base, grantId: draft.id })).rejects.toThrow(/is draft: work can't be charged/);
    world.grantDesk.propose(mei, draft.id);
    const proposed = await world.verbs.assign(mei, { ...base, grantId: draft.id });
    expect(world.budget.canStart(mei.id, world.assignments.require(proposed.assignmentId))).toBe(false);
    world.grantDesk.decide(admin, draft.id, { action: "reject", note: "not now" });
    await expect(world.verbs.assign(mei, { ...base, grantId: draft.id })).rejects.toThrow(/is rejected: work can't be charged/);
    const g = fund();
    expect((await world.verbs.assign(mei, { ...base, grantId: g.id })).assignmentId).toBeTruthy();
    world.grantDesk.close(admin, g.id, { outcome: "met" });
    await expect(world.verbs.assign(mei, { ...base, grantId: g.id })).rejects.toThrow(/is closed: work can't be charged/);
  });

  it("a session copies lane and grantId from its assignment at start", () => {
    const { world, admin, noor, fund } = setup();
    const g = fund();
    const a = world.ops.createWork(admin, noor.id, { title: "kr", lane: "grant", grantId: g.id });
    const s = world.ops.startSession(noor.id, { purpose: "work", model: "m", assignmentId: a.id });
    expect(world.sessions.require(s.id)).toMatchObject({ lane: "grant", grantId: g.id });
    world.ops.endSession(s.id, { status: "done", tokens: 1230 });
    // a grant's spend is its sessions' adjusted output tokens (Bank step 3): 1230 raw back-filled on Opus = 41
    expect(world.grantDesk.spent(g.id)).toBe(41);
  });
});

describe("goal-directed budgets: the canStart gate", () => {
  it("a grant task is held while its grant is at checkpoint (stays pending, with a reason); work behind it still starts", () => {
    const { world, admin, noor, fund } = setup();
    creditBank(world); // the seeded Bank holds nothing: exploration needs free tokens
    const g = fund();
    const held = world.ops.createWork(admin, noor.id, { title: "kr", lane: "grant", grantId: g.id });
    const ex = world.ops.createWork(admin, noor.id, { title: "explore", lane: "exploration", gap: "no gap sentence yet" });
    expect(world.budget.canStart(noor.id, held)).toBe(true);
    expect(nextStartable(world, noor.id)?.id).toBe(held.id);
    world.grants.patch(g.id, { status: "checkpoint" });
    expect(world.budget.canStart(noor.id)).toBe(true); // the agent itself isn't out of budget
    expect(world.budget.canStart(noor.id, held)).toBe(false);
    expect(world.assignments.require(held.id)).toMatchObject({ status: "pending", heldReason: "held: grant at checkpoint" });
    expect(nextStartable(world, noor.id)?.id).toBe(ex.id);
    world.grants.patch(g.id, { status: "funded" });
    expect(world.budget.canStart(noor.id, held)).toBe(true);
    expect(world.assignments.require(held.id).heldReason).toBeNull();
  });

  it("exploration is held with no free tokens, or once its goal's optional cap is reached today; uncapped by default; directed is never held", () => {
    const { world, admin, noor, spend } = setup();
    const ex = world.ops.createWork(admin, noor.id, { title: "explore", lane: "exploration", gap: "gap" });
    const dir = world.ops.createWork(admin, noor.id, { title: "directed" });
    // the seeded Bank holds nothing: no free tokens
    expect(world.budget.canStart(noor.id, ex)).toBe(false);
    expect(world.assignments.require(ex.id).heldReason).toMatch(/^held: no free tokens under its goal/);
    expect(world.budget.canStart(noor.id, dir)).toBe(true);
    creditBank(world, 5000);
    expect(world.budget.canStart(noor.id, ex)).toBe(true);
    // no cap anywhere up the tree: spend doesn't hold it
    spend(noor.id, 2000, "exploration");
    expect(world.grantDesk.exploration(LAB).cap).toBeNull();
    expect(world.budget.canStart(noor.id, ex)).toBe(true);
    // a cap on the root is town-wide; it holds once today's exploration under it reaches it
    world.goalTree.update(admin, "gl_town", { exploreCapTokensPerDay: 2000 });
    expect(world.budget.canStart(noor.id, ex)).toBe(false);
    expect(world.assignments.require(ex.id).heldReason).toMatch(/^held: exploration cap reached today \(2,000 \/ 2,000 tokens, set on goal gl_town\)/);
    expect(world.budget.canStart(noor.id, dir)).toBe(true);
    // null = inherit: uncapped again
    world.goalTree.update(admin, "gl_town", { exploreCapTokensPerDay: null });
    expect(world.budget.canStart(noor.id, ex)).toBe(true);
  });

  it("the Town Hall never holds on lanes; a lab does", () => {
    const { world, admin, noor, spend } = setup();
    fundGoalOf(world, LAB, { exploreCapTokensPerDay: 1 });
    const ex = world.ops.createWork(admin, noor.id, { title: "explore", lane: "exploration", gap: "gap" });
    spend(noor.id, 50, "exploration");
    expect(laneBlock(world, ex)?.kind).toBe("exploration");
    const hall = world.buildings.first("kind = 'town-hall'")!;
    expect(laneBlock(world, { ...ex, buildingId: hall.id })).toBeNull();
  });
});

describe("goal-directed budgets: the 100% checkpoint", () => {
  it("a grant at 60% spend creates no checkpoint assignment and is not held", () => {
    const { world, admin, mei, noor, fund, spend } = setup();
    const g = fund(4_000_000);
    spend(noor.id, 2_400_000, "grant", g.id);
    world.budget.charge(noor.id, 0, 0);
    expect(world.grants.require(g.id)).toMatchObject({ status: "funded", checkpointsDone: [] });
    expect(world.events.recent({ types: ["grant.checkpoint"] })).toHaveLength(0);
    expect(world.assignments.where("agentId = ? AND title LIKE 'Write the checkpoint%'", [mei.id])).toHaveLength(0);
    const step = world.ops.createWork(admin, noor.id, { title: "next step", lane: "grant", grantId: g.id });
    expect(world.budget.canStart(noor.id, step)).toBe(true);
  });

  it("a charge that reaches 100% holds the grant once and gives the manager the checkpoint assignment, which may run", () => {
    const { world, admin, mei, noor, fund, spend } = setup();
    const g = fund(4_000_000);
    spend(noor.id, 3_900_000, "grant", g.id);
    world.budget.charge(noor.id, 0, 0);
    expect(world.grants.require(g.id).status).toBe("funded");
    spend(noor.id, 200_000, "grant", g.id);
    world.budget.charge(noor.id, 0, 0);
    expect(world.grants.require(g.id)).toMatchObject({ status: "checkpoint", checkpointsDone: [1] });
    expect(world.events.recent({ types: ["grant.checkpoint"] })).toHaveLength(1);
    const cps = world.assignments.where("agentId = ? AND status = 'pending' AND title LIKE 'Write the checkpoint%'", [mei.id]);
    expect(cps).toHaveLength(1);
    expect(cps[0]).toMatchObject({ lane: "grant", grantId: g.id, keyResultId: null, title: "Write the checkpoint for Visitors can tell what the lab is for" });
    expect(cps[0].description).toContain("checkpoint_grant");
    expect(world.budget.canStart(mei.id, cps[0])).toBe(true);
    const step = world.ops.createWork(admin, noor.id, { title: "next step", lane: "grant", grantId: g.id });
    expect(world.budget.canStart(noor.id, step)).toBe(false);
    expect(world.messages.where("toId = ? AND kind = 'system'", [admin.id]).some((m) => m.body.includes("crossed 100%"))).toBe(true);
    // once: another charge doesn't repeat it
    world.budget.charge(noor.id, 0, 0);
    expect(world.assignments.where("agentId = ? AND status = 'pending' AND title LIKE 'Write the checkpoint%'", [mei.id])).toHaveLength(1);
    // topped up, then past the new 100%: checkpoint again
    world.grantDesk.decide(admin, g.id, { action: "adjust", tokens: 6_000_000 });
    world.budget.charge(noor.id, 0, 0);
    expect(world.grants.require(g.id)).toMatchObject({ status: "funded", checkpointsDone: [] });
    spend(noor.id, 2_000_000, "grant", g.id);
    world.budget.charge(noor.id, 0, 0);
    expect(world.grants.require(g.id)).toMatchObject({ status: "checkpoint", checkpointsDone: [1] });
    expect(world.assignments.where("agentId = ? AND status = 'pending' AND title LIKE 'Write the checkpoint%'", [mei.id])).toHaveLength(2);
  });

  it("releaseHalfway frees a grant still held at the retired 50% checkpoint, once; a held 100% grant stays held", () => {
    const { world, admin, noor, fund, spend } = setup();
    const g = fund(4_000_000);
    spend(noor.id, 2_100_000, "grant", g.id);
    world.grants.patch(g.id, { status: "checkpoint", checkpointsDone: [0.5] });
    const full = fund(1_000_000, [KRS[1]!]);
    expect(world.grantDesk.releaseHalfway().map((r) => r.id)).toEqual([g.id]);
    expect(world.grants.require(g.id).status).toBe("funded");
    expect(world.budget.canStart(noor.id, world.ops.createWork(admin, noor.id, { title: "step", lane: "grant", grantId: g.id }))).toBe(true);
    expect(world.grantDesk.releaseHalfway()).toEqual([]);
    // a human continuing meanwhile is harmless: the grant is funded and left alone
    expect(() => world.grantDesk.decide(admin, g.id, { action: "continue" })).toThrow(/checkpoint/);
    spend(noor.id, 1_000_000, "grant", full.id);
    world.grants.patch(full.id, { status: "checkpoint", checkpointsDone: [1] });
    expect(world.grantDesk.releaseHalfway()).toEqual([]);
    expect(world.grants.require(full.id).status).toBe("checkpoint");
  });

  it("checkpoint_grant sets the status of the grant's key results up to claimed; the checkpoint session's rollup links itself and lands in the Town Hall in-tray", async () => {
    const { world, mei, noor, fund, spend } = setup();
    const g = fund(4_000_000, KRS);
    const krs = g.keyResults;
    spend(noor.id, 4_100_000, "grant", g.id);
    world.budget.charge(noor.id, 0, 0);
    const cp = world.assignments.first("agentId = ? AND status = 'pending' AND title LIKE 'Write the checkpoint%'", [mei.id])!;
    world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: cp.id });
    expect(cp.description).toContain(`Key results (the grant's own):\n- ${krs[0]!.id} [not-started] ${KRS[0]!.text}`);
    expect(cp.description).toContain(`- ${krs[1]!.id} [not-started] ${KRS[1]!.text}`);
    await expect(world.verbs.checkpoint_grant(noor, { grantId: g.id })).rejects.toThrow(/building.manage/);
    await expect(world.verbs.checkpoint_grant(mei, { grantId: g.id, status: "met" as never })).rejects.toThrow();
    await expect(world.verbs.checkpoint_grant(mei, { grantId: g.id, status: "on-track", keyResultId: "kr_nope" })).rejects.toThrow(/not an open key result of grant/);
    // one at a time with keyResultId
    await world.verbs.checkpoint_grant(mei, { grantId: g.id, status: "at-risk", note: "board not yet", keyResultId: krs[1]!.id });
    expect(world.keyResults.require(krs[1]!.id)).toMatchObject({ status: "at-risk", statusNote: "board not yet" });
    expect(world.keyResults.require(krs[0]!.id).status).toBe("not-started");
    // no keyResultId: every open key result of the grant
    const r = await world.verbs.checkpoint_grant(mei, { grantId: g.id, status: "claimed", note: "banner shows it" });
    expect(r).toMatchObject({ status: "checkpoint", checkpointDocId: null, keyResult: { id: krs[0]!.id, status: "claimed" } });
    for (const k of krs) expect(world.keyResults.require(k.id)).toMatchObject({ status: "claimed", statusNote: "banner shows it" });
    const up = await world.verbs.submit_report(mei, { title: "Checkpoint", body: "## Shipped\nx\n## Decided\nx\n## Key results\nx\n## Needs from Mitchell\ncontinue", verdict: "continue", rollup: true });
    expect(up).toMatchObject({ intray: "town-hall" });
    expect(world.docs.require(up.id).tags).toEqual(["rollup", "checkpoint"]);
    expect(world.grants.require(g.id).checkpointDocId).toBe(up.id);
    expect(world.assignments.require(cp.id).status).toBe("done");
  });

  it("checkpoint_grant still files after a human topped up the grant before the manager's checkpoint session; a never-held funded grant refuses", async () => {
    const { world, mei, noor, fund, spend, admin } = setup();
    const g = fund(4_000_000);
    await expect(world.verbs.checkpoint_grant(mei, { grantId: g.id, status: "on-track" })).rejects.toThrow(/funded grant can't be checkpointed/);
    spend(noor.id, 4_100_000, "grant", g.id);
    world.budget.charge(noor.id, 0, 0);
    // Mitchell tops it up from the in-tray minutes after the hold (gr_jkorz4f49a, 2026-10-27 03:58Z), before the checkpoint report lands
    expect(world.grantDesk.decide(admin, g.id, { action: "adjust", tokens: 6_000_000 }).status).toBe("funded");
    const cp = world.assignments.first("agentId = ? AND status = 'pending' AND title LIKE 'Write the checkpoint%'", [mei.id])!;
    world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: cp.id });
    const r = await world.verbs.checkpoint_grant(mei, { grantId: g.id, status: "on-track", note: "steps 1-2 live" });
    expect(r).toMatchObject({ status: "funded", keyResult: { id: g.keyResultId, status: "on-track" } });
    const up = await world.verbs.submit_report(mei, { title: "Checkpoint", body: "## Shipped\nx\n## Decided\nx\n## Key results\nx\n## Needs from Mitchell\nnothing", verdict: "continue", rollup: true });
    expect(world.grants.require(g.id)).toMatchObject({ status: "funded", checkpointDocId: up.id });
  });

  it("close_grant: the manager closes a funded grant early as done; all its open KRs claimed, unspent returned, in the Town Hall in-tray until a human marks them", async () => {
    const { world, mei, noor, admin, fund, spend } = setup();
    const g = fund(4_000_000, KRS);
    const krs = g.keyResults;
    spend(noor.id, 1_000_000, "grant", g.id);
    await expect(world.verbs.close_grant(noor, { grantId: g.id, note: "done" })).rejects.toThrow(/building.manage/);
    const draft = world.grantDesk.create(mei, LAB, { keyResults: [KRS[1]!], objective: "o", stopCondition: "s", askTokens: 1 });
    await expect(world.verbs.close_grant(mei, { grantId: world.grantDesk.propose(mei, draft.id).id, note: "done" })).rejects.toThrow(/proposed grant can't be closed/);
    world.ops.startSession(mei.id, { purpose: "work", model: "m" });
    const r = await world.verbs.close_grant(mei, { grantId: g.id, note: "the banner shows Usage live" });
    expect(r).toMatchObject({ status: "closed", outcome: "done", spentTokens: 1_000_000, grantTokens: 4_000_000, unspentTokens: 3_000_000, keyResult: { status: "claimed" }, checkpointDocId: null });
    for (const k of krs) expect(world.keyResults.require(k.id)).toMatchObject({ status: "claimed", statusNote: "the banner shows Usage live" });
    expect(world.grants.require(g.id).history.at(-1)).toMatchObject({ action: "close", tokens: 3_000_000 });
    expect(world.grants.require(g.id).history.at(-1)!.note).toMatch(/returned 3,000,000 unspent tokens to the Bank/);
    const ev = world.events.recent({ types: ["grant.closed"] }).at(-1)!;
    expect(ev.payload).toMatchObject({ grantId: g.id, outcome: "done", spentTokens: 1_000_000, grantTokens: 4_000_000, unspentTokens: 3_000_000 });
    await expect(world.verbs.close_grant(mei, { grantId: g.id, note: "again" })).rejects.toThrow(/already closed/);
    // the manager can't mark met; the rollup links itself as the close report
    expect(() => world.grantDesk.updateKeyResult(mei, krs[0]!.id, { status: "met" })).toThrow(/building.fund/);
    const up = await world.verbs.submit_report(mei, { title: "Closed", body: "## Shipped\nx\n## Decided\nx\n## Key results\nx\n## Needs from Mitchell\nmark it", verdict: "stop", rollup: true });
    expect(world.docs.require(up.id).tags).toContain("grant-close");
    expect(world.grants.require(g.id).checkpointDocId).toBe(up.id);
    // in the Town Hall in-tray (and its count) until a human marks its KRs met or missed
    const th = world.buildings.first("kind = 'town-hall'")!;
    expect(world.ops.townHallIntray().grants.map((x) => x.id)).toContain(g.id);
    const before = world.ops.intrayCount(th.id);
    const sent: number[] = [];
    world.changes.subscribe((m) => { if (m.type === "building" && m.building.id === th.id && m.building.intray !== undefined) sent.push(m.building.intray); });
    world.grantDesk.updateKeyResult(admin, krs[1]!.id, { status: "missed", note: "not on the board" });
    world.grantDesk.updateKeyResult(admin, krs[0]!.id, { status: "met", note: "checked" });
    expect(world.ops.townHallIntray().grants.map((x) => x.id)).not.toContain(g.id);
    expect(world.ops.intrayCount(th.id)).toBe(before - 1);
    // marking the KR is not a grant event, but the Town Hall badge is resent with the new count
    expect(sent.at(-1)).toBe(before - 1);
  });

  it("a human's Close grant needs no note: the key result's claimed note names who closed it; the manager still gives one", async () => {
    const { world, mei, admin, fund } = setup();
    const g = fund(1_000_000);
    expect(() => world.grantDesk.close(mei, g.id, { outcome: "done", note: " " })).toThrow(/evidence/);
    const r = world.grantDesk.close(admin, g.id, { outcome: "done" });
    expect(r).toMatchObject({ status: "closed", outcome: "done", keyResult: { status: "claimed" } });
    const note = `Closed as done by ${world.nameOf(admin.id)} from the Town Hall.`;
    expect(world.keyResults.require(g.keyResultId!).statusNote).toBe(note);
    expect(world.grants.require(g.id).history.at(-1)!.note).toMatch(/^Closed as done by .+ from the Town Hall\. \(spent 0 of 1,000,000/);
  });

  it("propose_grant creates and proposes in one call; several proposals can be open per building", async () => {
    const { world, mei, admin } = setup();
    const r = await world.verbs.propose_grant(mei, { keyResults: KRS, objective: "o", stopCondition: "s", askTokens: 1000 });
    expect(r).toMatchObject({ status: "proposed", keyResult: { text: KRS[0]!.text }, keyResults: KRS.map((k) => ({ ...k, grantId: r.grantId })) });
    expect(world.grantDesk.board(LAB).proposals.map((p) => p.id)).toEqual([r.grantId]);
    const r2 = await world.verbs.propose_grant(mei, { keyResults: [KRS[0]!], objective: "o2", stopCondition: "s", askTokens: 1000 });
    expect(r2.grantId).not.toBe(r.grantId);
    expect(r2.note).toMatch(/1 other open proposal/);
    expect(world.grantDesk.board(LAB).proposals.map((p) => p.id).sort()).toEqual([r.grantId, r2.grantId].sort());
    // each is decided on its own: countering one leaves the other proposed; funding the other doesn't touch the counter
    world.grantDesk.decide(admin, r.grantId, { action: "counter", note: "smaller" });
    world.grantDesk.decide(admin, r2.grantId, { action: "fund" });
    expect(world.grants.require(r.grantId).status).toBe("countered");
    expect(world.grants.require(r2.grantId).status).toBe("funded");
    // a fresh plan answering the countered one: grantId names which is answered
    const r3 = await world.verbs.propose_grant(mei, { keyResults: [KRS[1]!], objective: "o3", stopCondition: "s", askTokens: 500, grantId: r.grantId });
    expect(r3.grantId).toBe(r.grantId);
    expect(world.grants.count("buildingId = ?", [LAB])).toBe(2);
  });

  it("propose_grant on a countered proposal rewrites it in place and re-proposes it under the same id", async () => {
    const { world, mei, noor, admin } = setup();
    const r = await world.verbs.propose_grant(mei, { keyResults: [KRS[1]!], objective: "o", stopCondition: "s", askTokens: 1000 });
    const queued = world.ops.createWork(mei, noor.id, { title: "kr", lane: "grant", grantId: r.grantId });
    world.grantDesk.decide(admin, r.grantId, { action: "counter", note: "track every token type" });
    const again = await world.verbs.propose_grant(mei, { keyResults: KRS, objective: "o, every token type", approach: "five counters", stopCondition: "s2", askTokens: 2000, note: "at your scope" });
    expect(again).toMatchObject({ grantId: r.grantId, status: "proposed", keyResults: KRS });
    expect(again.note).toMatch(/Re-proposed/);
    expect(world.grants.count("buildingId = ?", [LAB])).toBe(1);
    const g = world.grants.require(r.grantId);
    expect(g).toMatchObject({ objective: "o, every token type", approach: "five counters", stopCondition: "s2", askTokens: 2000 });
    expect(g.history.map((h) => h.action)).toEqual(["propose", "counter", "edit", "propose"]);
    expect(g.history.at(-1)?.note).toBe("at your scope");
    expect(world.assignments.require(queued.id)).toMatchObject({ grantId: r.grantId, status: "pending", keyResultId: g.keyResultId });
    // a proposal still awaiting the human's decision is not overwritten: grantId must name a countered one
    await expect(world.verbs.propose_grant(mei, { keyResults: [KRS[1]!], objective: "o3", stopCondition: "s", askTokens: 1, grantId: r.grantId })).rejects.toThrow(/only a countered proposal/);
    // without grantId it is a new proposal next to it
    const fresh = await world.verbs.propose_grant(mei, { keyResults: [KRS[1]!], objective: "o3", stopCondition: "s", askTokens: 1 });
    expect(fresh.grantId).not.toBe(r.grantId);
  });
});

describe("goal-directed budgets: the Key results block", () => {
  it("lists each goal of the subtree with its grants, their own KRs and statuses, spend and the session's lane; empty in the Town Hall", () => {
    const { world, mei, noor, admin, fund, spend } = setup();
    const g = fund(4_000_000);
    const krs = g.keyResults;
    const p = world.grantDesk.propose(mei, world.grantDesk.create(mei, LAB, { keyResults: [KRS[1]!], objective: "The board leads with the goal", stopCondition: "s", askTokens: 1000 }).id);
    spend(noor.id, 1_000_000, "grant", g.id);
    const a = world.ops.createWork(admin, noor.id, { title: "kr", lane: "grant", grantId: g.id });
    const block = keyResultsBlock(world, world.buildings.require(LAB), a);
    expect(block).toContain(`- grant ${g.id} "Visitors can tell what the lab is for" (funded; 1,000,000 / 4,000,000 tokens). Its key results:\n      - ${krs[0]!.id} [not-started] A visitor can see today's spend on the banner (how to check: Open the lab banner, read Usage)`);
    expect(block).toContain(`- grant ${p.id} "The board leads with the goal" (proposed: a human decides it in the Town Hall in-tray; asks 1,000 tokens). Its key results:\n      - ${p.keyResultId} [not-started] The board shows the lab's goal first (how to check: Open the lab board)`);
    expect(block).toContain(`This session: grant ${g.id} (first key result ${krs[0]!.id} "A visitor can see today's spend on the banner")`);
    expect(block).toMatch(/Exploration today: 0 tokens \(no allowance: held only when no tokens are free under the goal\)\. Free tokens under the goal: 0\./);
    const ex = world.ops.createWork(admin, noor.id, { title: "explore", gap: "Visitors can't find the board" });
    expect(keyResultsBlock(world, world.buildings.require(LAB), ex)).toContain("This session: exploration on gap: Visitors can't find the board");
    const b = world.buildings.require(LAB);
    const sys = workSystemPrompt(noor, b, world.town.get(), sessionMemory(world, noor, b, a));
    expect(sys).toMatch(/Building goal: .*\nKey results of the building goal \(this building is goal-directed/);
    // the manager gets the grants instructions
    expect(sessionMemory(world, mei, b).team).toContain("propose_grant");
    expect(keyResultsBlock(world, world.buildings.first("kind = 'town-hall'")!, a)).toBe("");
  });
});

describe("goal-directed budgets: a decision on a proposal wakes the manager (1:1 mt_f45m8hbmct)", () => {
  const propose = (world: ReturnType<typeof setup>["world"], mei: ReturnType<typeof setup>["mei"]) =>
    world.grantDesk.propose(mei, world.grantDesk.create(mei, LAB, { keyResults: [KRS[0]!, { text: "Banner shows Usage", howToCheck: "Open the banner" }], objective: "Visitors can tell what the lab is for", approach: "a banner line", stopCondition: "two failed tries", askTokens: 4_000_000, findingsDocIds: [] }).id);

  it("funded: a front-of-queue grant-lane assignment with the plan, which may run", () => {
    const { world, admin, mei } = setup();
    const g = propose(world, mei);
    expect(world.assignments.where("agentId = ? AND status = 'pending'", [mei.id])).toHaveLength(0);
    world.grantDesk.decide(admin, g.id, { action: "fund", note: "go" });
    const [a, ...rest] = world.assignments.where("agentId = ? AND status = 'pending'", [mei.id]);
    expect(rest).toHaveLength(0);
    expect(a).toMatchObject({ lane: "grant", grantId: g.id, keyResultId: g.keyResultId, createdBy: "system", title: `Grant ${g.id} funded: assign its first step or take it yourself` });
    expect(a!.description).toContain("4,000,000 tokens");
    expect(a!.description).toContain("The note: go");
    expect(a!.description).toContain("Approach: a banner line");
    expect(a!.description).toContain("Banner shows Usage");
    expect(a!.description).toContain(`grantId ${g.id}`);
    expect(a!.description).toContain(`Key results (the grant's own):\n- ${g.keyResultId} [not-started] ${KRS[0]!.text}`);
    expect(world.budget.canStart(mei.id, a!)).toBe(true);
    expect(nextStartable(world, mei.id)?.id).toBe(a!.id);
  });

  it("countered: a directed 'Answer the counter' assignment with the note; rejected: 'read the note'", () => {
    const { world, admin, mei } = setup();
    const g = propose(world, mei);
    world.grantDesk.decide(admin, g.id, { action: "counter", tokens: 2_000_000, note: "half, and a sharper plan" });
    const c = world.assignments.first("agentId = ? AND status = 'pending'", [mei.id])!;
    expect(c).toMatchObject({ lane: "directed", grantId: null, keyResultId: null, title: "Answer the counter on Visitors can tell what the lab is for" });
    expect(c.description).toContain("The note: half, and a sharper plan");
    expect(c.description).toContain("ask now 2,000,000 tokens");
    expect(c.description).toContain("propose_grant");
    expect(world.budget.canStart(mei.id, c)).toBe(true);
    // the manager answers: the same proposal goes back; a rejection wakes it once more
    world.grantDesk.update(mei, g.id, { note: "sharpened" });
    world.grantDesk.propose(mei, g.id);
    world.grantDesk.decide(admin, g.id, { action: "reject", note: "not this quarter" });
    const pending = world.assignments.where("agentId = ? AND status = 'pending'", [mei.id]);
    expect(pending).toHaveLength(2);
    const r = pending.find((a) => a.id !== c.id)!;
    expect(r).toMatchObject({ lane: "directed", title: `Grant ${g.id} rejected: read the note` });
    expect(r.description).toContain("The note: not this quarter");
    expect(r.description).toContain(`Its key results (they close with it):\n- ${g.keyResultId} [not-started]`);
    expect(world.keyResults.require(g.keyResultId!).archivedAt).toBeTruthy();
    expect(world.budget.canStart(mei.id, r)).toBe(true);
  });

  it("no manager agent: nothing is queued (a human works the in-tray)", () => {
    const { world, admin, mei } = setup();
    world.ops.updateBuilding(admin, LAB, { managerAgentId: null });
    const g = propose(world, mei);
    world.grantDesk.decide(admin, g.id, { action: "fund" });
    expect(world.assignments.where("agentId = ? AND status = 'pending'", [mei.id])).toHaveLength(0);
  });
});

describe("goal-directed budgets: human-directed work (1:1 mt_ryw7ejayvu)", () => {
  const base = (agentId: string) => ({ agentId, title: "t", description: "d" });

  it("an agent creates directed work only when it cites a human source; it is stored and never held by the allowance", async () => {
    const { world, mei, noor, admin, spend } = setup();
    await expect(world.verbs.assign(mei, { ...base(mei.id), lane: "directed" })).rejects.toThrow(/goal-directed.*agents can't create directed work\.$/);
    const own = await world.verbs.write(mei, { title: "my note", body: "x", type: "note", state: "building" });
    await expect(world.verbs.assign(mei, { ...base(mei.id), lane: "directed", sourceId: own.id })).rejects.toThrow(/isn't human-authored/);
    const flag = world.ops.plantFlag(admin, LAB, "Make the banner readable");
    const r = await world.verbs.assign(mei, { ...base(mei.id), lane: "directed", sourceId: flag.id, gap: "the banner is unreadable" });
    const a = world.assignments.require(r.assignmentId);
    expect(a).toMatchObject({ lane: "directed", sourceId: flag.id, gap: "the banner is unreadable", keyResultId: null });
    // the exploration cap doesn't hold it; its spend lands in the directed bucket
    const capGoal = fundGoalOf(world, LAB, { exploreCapTokensPerDay: 1000 });
    spend(mei.id, 1000, "exploration");
    expect(world.budget.canStart(mei.id, a)).toBe(true);
    world.sessions.upsert({ ...world.sessions.where("agentId = ?", [mei.id])[0]!, id: newId("se"), lane: "directed" });
    expect(world.grantDesk.directed(LAB).spentTodayTokens).toBe(1000);
    expect(world.grantDesk.laneBudgets().find((b) => b.buildingId === LAB)).toMatchObject({ exploration: { spentTodayTokens: 1000, cap: { tokensPerDay: 1000, goalId: capGoal, spentTodayTokens: 1000 } }, directed: { spentTodayTokens: 1000 } });
    expect(keyResultsBlock(world, world.buildings.require(LAB), a)).toMatch(/Directed today: 1,000 tokens[\s\S]*This session: directed \(a human asked for it: dc_/);
    // a review continue may name the lane too
    expect((await world.verbs.assign(mei, { ...base(mei.id), sourceId: flag.id })).lane).toBe("directed");
  });

  it("a meeting is a human source only if a human took part; its decisions record it as their source", async () => {
    const { world, mei, noor, admin } = setup();
    const m = world.ops.createMeeting(admin, { kind: "standup", buildingId: LAB, startNow: true });
    await expect(world.verbs.assign(mei, { ...base(mei.id), lane: "directed", sourceId: m.id })).rejects.toThrow(/had no human in it/);
    const decide = (text: string, extra = {}) => world.ops.meetingDecide(mei, m.id, [{ text, assigneeId: noor.id, assignmentId: null, ...extra }]);
    // meeting decisions stay exempt (directed); without a human in the meeting they cite no source
    expect(world.assignments.require(decide("no lane").decisions[0]!.assignmentId!)).toMatchObject({ lane: "directed", sourceId: null });
    world.meetings.upsert({ ...world.meetings.require(m.id), transcript: [{ speakerId: "us_x", speakerKind: "user", text: "please do X", at: nowIso() }] });
    const out = decide("do X");
    expect(world.assignments.require(out.decisions[1]!.assignmentId!)).toMatchObject({ lane: "directed", sourceId: m.id });
    expect((await world.verbs.assign(mei, { ...base(mei.id), lane: "directed", sourceId: m.id })).lane).toBe("directed");
  });

  it("exploration names a gap and directed work may; neither names a key result", async () => {
    const { world, mei, admin } = setup();
    await expect(world.verbs.assign(mei, { ...base(mei.id), lane: "exploration" })).rejects.toThrow(/names a goal gap/);
    const ex = await world.verbs.assign(mei, { ...base(mei.id), lane: "exploration", gap: "nobody reads the board" });
    expect(world.assignments.require(ex.assignmentId)).toMatchObject({ lane: "exploration", gap: "nobody reads the board", keyResultId: null, grantId: null });
    const flag = world.ops.plantFlag(admin, LAB, "Look at the banner");
    const r = await world.verbs.assign(mei, { ...base(mei.id), lane: "directed", sourceId: flag.id, gap: "the banner says nothing" });
    const a = world.assignments.require(r.assignmentId);
    expect(a).toMatchObject({ lane: "directed", gap: "the banner says nothing", keyResultId: null });
    expect(world.budget.canStart(mei.id, a)).toBe(true);
    world.grantDesk.propose(mei, world.grantDesk.create(mei, LAB, { keyResults: [KRS[1]!], objective: "o", stopCondition: "s", askTokens: 1 }).id);
    expect(world.budget.canStart(mei.id, a)).toBe(true);
    expect(laneBlock(world, a)).toBeNull();
  });
});
