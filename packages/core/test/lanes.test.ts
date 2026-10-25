import { describe, expect, it } from "vitest";
import { buildingRoleId, createAssignment, keyResultsBlock, newId, nextStartable, nowIso, sessionMemory, workSystemPrompt } from "../src/index.ts";
import { BUDGET_POLICY } from "../src/policy.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const KRS = [
  { text: "A visitor can see today's spend on the banner", howToCheck: "Open the lab banner, read Usage" },
  { text: "The board shows the lab's goal first", howToCheck: "Open the lab board" },
];
const REPORT = "## What I did\nx\n## Findings\ny\n## What I need from you\nNothing needed.";

/** Mei manages the lab (manager agent + role), Noor is a resident; `goal` flips the lab to goal-directed. */
function setup(goal = true) {
  const s = seededWorld();
  const { world, by, admin } = s;
  const mei = by("Mei"), noor = by("Noor");
  // a human writes the goal's key results (before goal-directed, so the lab is never blocked here)
  const krs = KRS.map((k) => world.grantDesk.createKeyResult(admin, LAB, k));
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id, budgetMode: goal ? "goal-directed" : "open" });
  world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
  const fund = (tokens = 4_000_000, keyResultId = krs[0]!.id) => {
    const g = world.grantDesk.propose(mei, world.grantDesk.create(mei, LAB, { keyResultId, objective: "Visitors can tell what the lab is for", stopCondition: "two failed tries", askTokens: tokens, testingPlan: [{ text: "Banner shows Usage", howToCheck: "Open the banner" }] }).id);
    return world.grantDesk.decide(admin, g.id, { action: "fund" });
  };
  /** a finished session that spent `tokens` in a lane (what a grant's spend is derived from) */
  const spend = (agentId: string, tokens: number, lane: "grant" | "exploration", grantId: string | null = null) => world.sessions.upsert({
    id: newId("se"), agentId, assignmentId: null, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
    sdkSessionId: null, tokens, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane, grantId,
  });
  return { ...s, mei, noor, krs, fund, spend };
}

describe("goal-directed budgets: lanes on assignments", () => {
  it("open buildings keep today's behaviour: no lane = directed, agents may assign it", async () => {
    const { world, mei, noor } = setup(false);
    const r = await world.verbs.assign(mei, { agentId: noor.id, title: "t", description: "d" });
    expect(world.assignments.require(r.assignmentId)).toMatchObject({ lane: "directed", grantId: null, keyResultId: null, gap: null, heldReason: null });
    expect(world.budget.canStart(noor.id, world.assignments.require(r.assignmentId))).toBe(true);
  });

  it("goal-directed: agents must say grant or exploration; fields are validated; humans may still create directed work", async () => {
    const { world, mei, noor, admin, krs, fund } = setup();
    const g = fund();
    const other = world.grantDesk.create(mei, LAB, { keyResultId: krs[1]!.id, objective: "other", stopCondition: "s", askTokens: 1 });
    const base = { agentId: noor.id, title: "t", description: "d" };
    await expect(world.verbs.assign(mei, base)).rejects.toThrow(/goal-directed.*agents can't create directed work/);
    await expect(world.verbs.assign(mei, { ...base, lane: "directed" })).rejects.toThrow(/goal-directed/);
    await expect(world.verbs.assign(mei, { ...base, lane: "exploration" })).rejects.toThrow(/key result.*goal gap/);
    await expect(world.verbs.assign(mei, { ...base, lane: "grant" })).rejects.toThrow(/names its grant/);
    await expect(world.verbs.assign(mei, { ...base, lane: "grant", grantId: g.id, keyResultId: krs[1]!.id })).rejects.toThrow(/works toward key result/);
    await expect(world.verbs.assign(mei, { ...base, lane: "grant", grantId: other.id })).rejects.toThrow(/draft/);
    // exploration: a goal KR without a funded grant, or a gap; a KR with a funded grant goes through the grant lane
    await expect(world.verbs.assign(mei, { ...base, lane: "exploration", keyResultId: krs[0]!.id })).rejects.toThrow(/has a funded grant/);
    const exk = await world.verbs.assign(mei, { ...base, keyResultId: krs[1]!.id });
    expect(world.assignments.require(exk.assignmentId)).toMatchObject({ lane: "exploration", keyResultId: krs[1]!.id, grantId: null });
    const ex = await world.verbs.assign(mei, { ...base, gap: "A visitor can't tell what the lab is for" });
    expect(world.assignments.require(ex.assignmentId)).toMatchObject({ lane: "exploration", gap: "A visitor can't tell what the lab is for", keyResultId: null });
    const gr = await world.verbs.assign(mei, { ...base, lane: "grant", grantId: g.id });
    expect(world.assignments.require(gr.assignmentId)).toMatchObject({ lane: "grant", grantId: g.id, keyResultId: krs[0]!.id });
    // POST /api/agents/:id/work by a human: directed bypasses grants (open question 2's default)
    expect(BUDGET_POLICY.directedBypassesGrants).toBe(true);
    expect(world.ops.createWork(admin, noor.id, { title: "fix the banner" }).lane).toBe("directed");
    expect(world.ops.createWork(admin, noor.id, { title: "kr work", lane: "grant", grantId: g.id, keyResultId: krs[0]!.id })).toMatchObject({ lane: "grant", grantId: g.id });
    // a continuation inherits its lane (no fields needed)
    const cont = createAssignment(world, { agentId: noor.id, title: "c", description: "d", createdBy: world.holderOf(mei), fromAssignmentId: gr.assignmentId });
    expect(cont).toMatchObject({ lane: "grant", grantId: g.id, keyResultId: krs[0]!.id });
  });

  it("a session copies lane and grantId from its assignment at start", () => {
    const { world, admin, noor, fund } = setup();
    const g = fund();
    const a = world.ops.createWork(admin, noor.id, { title: "kr", lane: "grant", grantId: g.id });
    const s = world.ops.startSession(noor.id, { purpose: "work", model: "m", assignmentId: a.id });
    expect(world.sessions.require(s.id)).toMatchObject({ lane: "grant", grantId: g.id });
    world.ops.endSession(s.id, { status: "done", tokens: 1234 });
    expect(world.grantDesk.spent(g.id)).toBe(1234);
  });
});

describe("goal-directed budgets: the canStart gate", () => {
  it("a grant task is held while its grant is at checkpoint (stays pending, with a reason); work behind it still starts", () => {
    const { world, admin, noor, fund } = setup();
    world.ops.updateBuilding(admin, LAB, { explorationTokensPerDay: 1_000_000 }); // the seeded pool has no daily inflow
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

  it("exploration is held once the building's exploration spend today reaches its allowance; directed is not", () => {
    const { world, admin, noor, spend } = setup();
    world.ops.updateBuilding(admin, LAB, { explorationTokensPerDay: 1000 });
    const ex = world.ops.createWork(admin, noor.id, { title: "explore", lane: "exploration", gap: "gap" });
    const dir = world.ops.createWork(admin, noor.id, { title: "directed" });
    expect(world.budget.canStart(noor.id, ex)).toBe(true);
    spend(noor.id, 1000, "exploration");
    expect(world.budget.canStart(noor.id, ex)).toBe(false);
    expect(world.assignments.require(ex.id).heldReason).toMatch(/^held: exploration allowance spent today \(1,000 \/ 1,000 tokens\)/);
    expect(world.budget.canStart(noor.id, dir)).toBe(true);
    // the default allowance (null) is 10% of the pool's daily inflow
    world.ops.updateBuilding(admin, LAB, { explorationTokensPerDay: null });
    const pool = world.bank.poolOf(LAB).id;
    expect(world.grantDesk.exploration(LAB).allowanceTokens).toBe(Math.floor(world.bank.poolDailyInflow(pool) * BUDGET_POLICY.explorationShare));
  });

  it("open buildings never hold on lanes", () => {
    const { world, admin, noor, spend } = setup(false);
    world.ops.updateBuilding(admin, LAB, { explorationTokensPerDay: 1 });
    const ex = world.ops.createWork(admin, noor.id, { title: "explore", lane: "exploration", gap: "gap" });
    spend(noor.id, 50, "exploration");
    expect(world.budget.canStart(noor.id, ex)).toBe(true);
  });
});

describe("goal-directed budgets: 50% / 100% checkpoints", () => {
  it("a charge that crosses 50% holds the grant once and gives the manager the checkpoint assignment, which may run", () => {
    const { world, admin, mei, noor, fund, spend } = setup();
    const g = fund(4_000_000);
    spend(noor.id, 1_900_000, "grant", g.id);
    world.budget.charge(noor.id, 0, 0);
    expect(world.grants.require(g.id).status).toBe("funded");
    spend(noor.id, 200_000, "grant", g.id);
    world.budget.charge(noor.id, 0, 0);
    expect(world.grants.require(g.id)).toMatchObject({ status: "checkpoint", checkpointsDone: [0.5] });
    expect(world.events.recent({ types: ["grant.checkpoint"] })).toHaveLength(1);
    const cps = world.assignments.where("agentId = ? AND status = 'pending'", [mei.id]);
    expect(cps).toHaveLength(1);
    expect(cps[0]).toMatchObject({ lane: "grant", grantId: g.id, keyResultId: null, title: "Write the checkpoint for Visitors can tell what the lab is for" });
    expect(cps[0].description).toContain("checkpoint_grant");
    expect(world.budget.canStart(mei.id, cps[0])).toBe(true);
    expect(world.messages.where("toId = ? AND kind = 'system'", [admin.id]).some((m) => m.body.includes("crossed 50%"))).toBe(true);
    // once per fraction: another charge doesn't repeat it
    world.budget.charge(noor.id, 0, 0);
    expect(world.assignments.where("agentId = ? AND status = 'pending'", [mei.id])).toHaveLength(1);
    // continued, then past 100%: checkpoint again
    world.grantDesk.decide(admin, g.id, { action: "continue", note: "go on" });
    world.budget.charge(noor.id, 0, 0);
    expect(world.grants.require(g.id).status).toBe("funded");
    spend(noor.id, 2_000_000, "grant", g.id);
    world.budget.charge(noor.id, 0, 0);
    expect(world.grants.require(g.id)).toMatchObject({ status: "checkpoint", checkpointsDone: [0.5, 1] });
    expect(world.assignments.where("agentId = ? AND status = 'pending'", [mei.id])).toHaveLength(2);
  });

  it("checkpoint_grant sets the grant's goal KR status up to claimed; the checkpoint session's rollup links itself and lands in the Town Hall in-tray", async () => {
    const { world, mei, noor, krs, fund, spend } = setup();
    const g = fund(4_000_000);
    spend(noor.id, 2_100_000, "grant", g.id);
    world.budget.charge(noor.id, 0, 0);
    const cp = world.assignments.first("agentId = ? AND status = 'pending'", [mei.id])!;
    world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: cp.id });
    expect(cp.description).toContain(`Key result (on the building goal): ${krs[0]!.id} [not-started]`);
    expect(cp.description).toContain("Testing plan:\n- Banner shows Usage");
    await expect(world.verbs.checkpoint_grant(noor, { grantId: g.id })).rejects.toThrow(/building.manage/);
    await expect(world.verbs.checkpoint_grant(mei, { grantId: g.id, status: "met" as never })).rejects.toThrow();
    const r = await world.verbs.checkpoint_grant(mei, { grantId: g.id, status: "claimed", note: "banner shows it" });
    expect(r).toMatchObject({ status: "checkpoint", checkpointDocId: null, keyResult: { id: krs[0]!.id, status: "claimed" } });
    expect(world.keyResults.require(krs[0]!.id)).toMatchObject({ status: "claimed", statusNote: "banner shows it" });
    const up = await world.verbs.submit_report(mei, { title: "Checkpoint", body: "## Shipped\nx\n## Decided\nx\n## Key results\nx\n## Needs from Mitchell\ncontinue", verdict: "continue", rollup: true });
    expect(up).toMatchObject({ intray: "town-hall" });
    expect(world.docs.require(up.id).tags).toEqual(["rollup", "checkpoint"]);
    expect(world.grants.require(g.id).checkpointDocId).toBe(up.id);
    expect(world.assignments.require(cp.id).status).toBe("done");
  });

  it("propose_grant creates and proposes in one call; one open proposal per building", async () => {
    const { world, mei, krs } = setup();
    const r = await world.verbs.propose_grant(mei, { keyResultId: krs[1]!.id, objective: "o", stopCondition: "s", askTokens: 1000, testingPlan: KRS });
    expect(r).toMatchObject({ status: "proposed", keyResult: { id: krs[1]!.id }, testingPlan: KRS });
    expect(world.grantDesk.board(LAB).proposal?.id).toBe(r.grantId);
    await expect(world.verbs.propose_grant(mei, { keyResultId: krs[1]!.id, objective: "o2", stopCondition: "s", askTokens: 1000 })).rejects.toThrow(/open proposal/);
    expect(world.grants.count("buildingId = ?", [LAB])).toBe(1);
  });
});

describe("goal-directed budgets: the Key results block", () => {
  it("sits right after the building goal with goal KRs, statuses, the grant on each, spend and the session's lane; empty in open buildings", () => {
    const { world, mei, noor, admin, krs, fund, spend } = setup();
    const g = fund(4_000_000);
    spend(noor.id, 1_000_000, "grant", g.id);
    const a = world.ops.createWork(admin, noor.id, { title: "kr", lane: "grant", grantId: g.id });
    const block = keyResultsBlock(world, world.buildings.require(LAB), a);
    expect(block).toContain(`- ${krs[0]!.id} [not-started] A visitor can see today's spend on the banner (how to check: Open the lab banner, read Usage); grant ${g.id} "Visitors can tell what the lab is for" (funded; 1,000,000 / 4,000,000 tokens)`);
    expect(block).toContain(`- ${krs[1]!.id} [not-started] The board shows the lab's goal first (how to check: Open the lab board); no funded grant: open for exploration`);
    expect(block).toContain(`This session: grant ${g.id}, key result ${krs[0]!.id}`);
    expect(block).toMatch(/Exploration today: 0 \/ [\d,]+ tokens/);
    const ex = world.ops.createWork(admin, noor.id, { title: "explore", gap: "Visitors can't find the board" });
    expect(keyResultsBlock(world, world.buildings.require(LAB), ex)).toContain("This session: exploration on gap: Visitors can't find the board");
    const b = world.buildings.require(LAB);
    const sys = workSystemPrompt(noor, b, world.town.get(), sessionMemory(world, noor, b, a));
    expect(sys).toMatch(/Building goal: .*\nKey results of the building goal \(this building is goal-directed/);
    // the manager gets the grants instructions
    expect(sessionMemory(world, mei, b).team).toContain("propose_grant");
    world.ops.updateBuilding(admin, LAB, { budgetMode: "open" });
    expect(keyResultsBlock(world, world.buildings.require(LAB), a)).toBe("");
    expect(sessionMemory(world, mei, world.buildings.require(LAB)).team).not.toContain("propose_grant");
  });
});
