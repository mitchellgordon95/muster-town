/** Manager forks step 1 (dc_mymt27yz25): the building queue, forkManager / retireFork, fork names, chainId and the family daily cap. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHAIN_PLAN_RULE, RESIDENT_NAMES, buildingQueue, chainBlock, createAssignment, createDoc, createBuilding, createResident, forkManager, forkSummary, forksOf, familySpend, reportChain, reportChains, nextStartable, retireFork, suggestResidentName, teamBlock, updateBuilding, workPrompt } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const CHAINS_SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "049_assignment_chains.sql"), "utf8");

/** A 3-desk lab (one key result, so not blocked) with a manager Pix and a resident Ann. */
function forkLab(opts: { daily?: number } = {}) {
  const s = seededWorld();
  const { world, seed } = s;
  const b = createBuilding(world, { name: "Forky", headcount: 3, dailyTokensPerAgent: opts.daily ?? 1000, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  world.grantDesk.createKeyResult(s.admin, b.id, { text: "Forks work", howToCheck: "Run the tests" }); // a key result, so the lab isn't blocked
  const pix = createResident(world, { buildingId: b.id, name: "Pix", sprite: 5 });
  const ann = createResident(world, { buildingId: b.id, name: "Ann" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  world.buildings.upsert({ ...world.buildings.require(b.id), explorationTokensPerDay: 10_000_000 }); // labs are lane-gated: queued exploration needs an allowance
  world.budget.donate(seed.admin.id, { tokens: 1_000_000, buildingId: b.id });
  const queue = async (title: string, extra: { model?: string } = {}) => (await world.verbs.assign(world.agents.require(pix.id), { title, description: "d", gap: "test gap", ...extra })).assignmentId;
  return { ...s, b: world.buildings.require(b.id), pix: world.agents.require(pix.id), ann, queue };
}

describe("manager forks: the building queue", () => {
  it("assign without an agentId queues to the building (held by the manager, never run by it); a named assign stays on the agent's queue", async () => {
    const { world, pix, b, queue } = forkLab();
    const id = await queue("Fix the thing");
    expect(world.assignments.require(id)).toMatchObject({ agentId: pix.id, queue: "building", chainId: id, model: null, buildingId: b.id });
    expect(buildingQueue(world, b.id).map((a) => a.id)).toEqual([id]);
    expect(nextStartable(world, pix.id)).toBeUndefined();
    await expect(queue("Live check", { model: "claude-sonnet-5-5" })).rejects.toThrow(/runs forks on claude-opus-5-5 or claude-haiku-5-5/);
    expect(world.assignments.require(await queue("Live check", { model: "claude-haiku-5-5" })).model).toBe("claude-haiku-5-5");
    await expect(world.verbs.assign(pix, { agentId: pix.id, title: "x", description: "d", model: "claude-haiku-5-5" })).rejects.toThrow(/building-queue work/);

    // the manager taking work itself names its own agentId
    const named = await world.verbs.assign(pix, { agentId: pix.id, title: "Mine", description: "d", gap: "test gap" });
    expect(world.assignments.require(named.assignmentId)).toMatchObject({ queue: "agent", agentId: pix.id, chainId: named.assignmentId });
  });

  it("forks are the only mode: there is no forks setting to turn off (1:1 mt_wngibcr98b)", async () => {
    const { world, b, queue } = forkLab();
    expect("forks" in world.buildings.require(b.id)).toBe(false);
    world.ops.updateBuilding(null, b.id, { forks: false } as never); // an old client's field is dropped
    const id = await queue("Still queued");
    expect(buildingQueue(world, b.id).map((a) => a.id)).toEqual([id]);
  });
});

describe("manager forks: forkManager and retireFork", () => {
  it("forks the manager onto a free desk without growing the lab, names it after the manager and retires it", async () => {
    const { world, pix, b, queue } = forkLab();
    const a1 = await queue("One"), a2 = await queue("Two", { model: "claude-haiku-5-5" });
    const f1 = forkManager(world, b.id, a1);
    expect(f1.fork).toMatchObject({ name: "Pix 1", forkOf: pix.id, forkN: 1, sprite: 5, model: "claude-opus-5-5", kind: "resident", homeBuildingId: b.id, currentAssignmentId: a1, inheritsOwner: false });
    expect(f1.desk).toBe(2); // Pix and Ann sit at 0 and 1
    expect(world.assignments.require(a1)).toMatchObject({ agentId: f1.fork.id, queue: "building" });
    expect(nextStartable(world, f1.fork.id)?.id).toBe(a1);
    expect(buildingQueue(world, b.id).map((a) => a.id)).toEqual([a2]);
    const forked = world.events.list({ types: ["agent.forked"] }).at(-1)!;
    expect(forked.text).toBe(`Pix forked Pix 1 for "One" at desk 2`);
    expect(forked.payload).toMatchObject({ forkOf: pix.id, forkN: 1, desk: 2, assignmentId: a1, chainId: a1, chainReportId: null });
    // the resident permission set: member, not manager
    expect(world.permissions.can(f1.fork, "building.assign", b.id)).toBe(false);
    expect(world.permissions.can(f1.fork, "building.review", b.id)).toBe(false);
    expect(world.permissions.can(pix, "building.assign", b.id)).toBe(true);

    // every desk taken: refused, nothing written, headcount unchanged
    const rows = world.agents.all().length;
    expect(() => forkManager(world, b.id, a2)).toThrow(/no free desk/);
    expect(world.agents.all().length).toBe(rows);
    expect(world.buildings.require(b.id).headcount).toBe(3);
    expect(world.assignments.require(a2).agentId).toBe(pix.id);

    // retire: desk released, tokens revoked, event with the report and adj. tokens; the name is free again
    world.tokens.create("agent", f1.fork.id);
    world.budget.charge(f1.fork.id, 41_000 / 100, 0);
    const r = retireFork(world, f1.fork.id, { reportId: "dc_report1" });
    expect(r.status).toBe("retired");
    expect(world.layout.deskOf(f1.fork.id)).toBeUndefined();
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE kind = 'agent' AND id = ?").get(f1.fork.id)).toEqual({ n: 0 });
    const retired = world.events.list({ types: ["agent.retired"] }).at(-1)!;
    expect(retired.text).toBe("Pix 1 retired (report dc_report1, 0k adj. tokens)");
    expect(retired.payload).toMatchObject({ forkOf: pix.id, forkN: 1, reportId: "dc_report1", tokens: 410, desk: 2 });
    expect(retireFork(world, f1.fork.id).status).toBe("retired"); // idempotent

    const f2 = forkManager(world, b.id, a2);
    expect(f2.fork).toMatchObject({ name: "Pix 1", forkN: 1, model: "claude-haiku-5-5" });
    expect(f2.fork.id).not.toBe(f1.fork.id);
  });

  it("names take the lowest n no live fork uses; resident names ignore forks", async () => {
    const { world, b, pix, queue } = forkLab();
    world.ops.updateBuilding(null, b.id, { headcount: 5 });
    world.agents.patch(pix.id, { name: "Ada" });
    const [x, y, z] = [await queue("x"), await queue("y"), await queue("z")];
    const fx = forkManager(world, b.id, x).fork, fy = forkManager(world, b.id, y).fork;
    expect([fx.name, fy.name]).toEqual(["Ada 1", "Ada 2"]);
    retireFork(world, fx.id);
    expect(forkManager(world, b.id, z).fork.name).toBe("Ada 1");
    // with the pool used up, numbered names start at "Ada 2": a live fork with that name doesn't block it
    expect(suggestResidentName(world, RESIDENT_NAMES, () => 0)).toBe("Ada 2");
  });

  it("work made for a fork (park continuation, follow-up) and work it still holds go back on the building queue", async () => {
    const { world, pix, b, queue } = forkLab();
    const a1 = await queue("One");
    const { fork } = forkManager(world, b.id, a1);
    const cont = createAssignment(world, { agentId: fork.id, title: "One (continued)", description: "d", createdBy: { kind: "system", id: "system" }, fromAssignmentId: a1 });
    expect(world.assignments.require(cont.id)).toMatchObject({ agentId: pix.id, queue: "building", chainId: a1 });
    world.assignments.upsert({ ...world.assignments.require(cont.id), agentId: fork.id });
    retireFork(world, fork.id, { reason: "died" });
    expect(world.assignments.require(cont.id)).toMatchObject({ agentId: pix.id, queue: "building" });
    expect(world.events.list({ types: ["agent.retired"] }).at(-1)!.payload).toMatchObject({ reason: "died" });
    // its own assignment never started (the runtime starts it after the fork), so it is back on the queue as well
    expect((world.events.list({ types: ["agent.retired"] }).at(-1)!.payload.requeued as string[]).sort()).toEqual([a1, cont.id].sort());
    expect(buildingQueue(world, b.id).map((a) => a.id).sort()).toEqual([a1, cont.id].sort());
  });

  it("refuses without a manager, or for work not on the building queue", async () => {
    const { world, b, ann, queue } = forkLab();
    const named = (await world.verbs.assign(world.agents.require(b.managerAgentId!), { agentId: ann.id, title: "Named", description: "d", gap: "test gap" })).assignmentId;
    expect(() => forkManager(world, b.id, named)).toThrow(/isn't on Forky's building queue/);
    const q = await queue("Q");
    updateBuilding(world, b.id, { managerAgentId: null });
    expect(() => forkManager(world, b.id, q)).toThrow(/no manager agent to fork/);
  });
});

describe("manager forks: chainId", () => {
  it("new assignments carry the chain's first id through retries and report follow-ups", () => {
    const { world, ann } = forkLab();
    const sys = { kind: "system" as const, id: "system" };
    const a = createAssignment(world, { agentId: ann.id, title: "A", description: "d", createdBy: sys });
    const retry = createAssignment(world, { agentId: ann.id, title: "A again", description: "d", createdBy: sys, fromAssignmentId: a.id });
    const follow = createAssignment(world, { agentId: ann.id, title: "Follow-up", description: "d", createdBy: sys, fromReportId: createReport(world, ann.id, retry.id) });
    expect([a.chainId, retry.chainId, follow.chainId]).toEqual([a.id, a.id, a.id]);
  });

  it("migration 049 backfills chainId from fromAssignmentId and fromReportId links", () => {
    const { world, ann } = forkLab();
    const sys = { kind: "system" as const, id: "system" };
    const root = createAssignment(world, { agentId: ann.id, title: "Root", description: "d", createdBy: sys });
    const retry = createAssignment(world, { agentId: ann.id, title: "Retry", description: "d", createdBy: sys, fromAssignmentId: root.id });
    const rep = createReport(world, ann.id, retry.id);
    const cont = createAssignment(world, { agentId: ann.id, title: "Continued", description: "d", createdBy: sys, fromReportId: rep });
    const lone = createAssignment(world, { agentId: ann.id, title: "Lone", description: "d", createdBy: sys });
    const orphan = createAssignment(world, { agentId: ann.id, title: "Orphan", description: "d", createdBy: sys, fromAssignmentId: lone.id });
    world.db.prepare("DELETE FROM assignments WHERE id = ?").run(lone.id);
    world.db.exec("UPDATE assignments SET chainId = NULL");
    world.db.exec(CHAINS_SQL);
    const chain = (id: string) => world.assignments.require(id).chainId;
    expect([chain(root.id), chain(retry.id), chain(cont.id)]).toEqual([root.id, root.id, root.id]);
    expect(chain(orphan.id)).toBe(orphan.id);
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE chainId IS NULL").get()).toEqual({ n: 0 });
  });
});

describe("manager forks: the family daily cap", () => {
  it("forks count against the manager's family (dailyTokensPerAgent × headcount), the manager's own sessions included", async () => {
    const { world, pix, b, queue } = forkLab({ daily: 100 }); // family cap 300
    const a1 = await queue("One");
    const { fork } = forkManager(world, b.id, a1);
    world.budget.charge(pix.id, 90, 0);
    expect(world.agents.require(pix.id).familySpentToday).toBe(90);
    expect(world.budget.charge(fork.id, 150, 0).exhausted).toBeNull(); // over its own 100: forks aren't capped per agent
    expect(world.agents.require(pix.id).familySpentToday).toBe(240);
    expect(world.agents.require(fork.id).familySpentToday).toBe(0);
    expect(world.budget.canStart(fork.id)).toBe(true);
    const r = world.budget.charge(fork.id, 60, 0);
    expect(r.exhausted).toBe("agent-daily");
    expect(world.events.list({ types: ["budget.exhausted"] }).at(-1)!.payload).toMatchObject({ scope: "family", forkOf: pix.id, familySpentToday: 300 });
    expect(world.budget.canStart(fork.id)).toBe(false);
    // the manager is held by its family cap too (its own 90 is under 100)
    expect(world.budget.canStart(pix.id)).toBe(false);
    world.budget.resetDaily();
    expect(world.agents.require(pix.id).familySpentToday).toBe(0);
    expect(world.budget.canStart(pix.id)).toBe(true);
  });

  it("a named resident other than the manager is capped per agent; its spend isn't the manager's family", () => {
    const { world, pix, ann } = forkLab({ daily: 100 });
    world.budget.charge(ann.id, 250, 0);
    expect(world.budget.canStart(pix.id)).toBe(true);
    expect(world.budget.canStart(ann.id)).toBe(false);
  });
});

/** A report doc on the assignment (what submit_report leaves behind). */
function createReport(world: ReturnType<typeof seededWorld>["world"], authorId: string, assignmentId: string): string {
  const id = `dc_r${Math.random().toString(36).slice(2, 10)}`;
  const ts = new Date().toISOString();
  world.docs.upsert({ id, type: "report", state: "building", title: "R", body: "b", authorId, authorKind: "agent", buildingId: world.agents.require(authorId).homeBuildingId, assignmentId, createdAt: ts, updatedAt: ts } as never);
  return id;
}

describe("manager forks: the chain block in a fork's work prompt (step 2)", () => {
  it("fresh chain: first session; later: the previous report on the chain in full plus earlier hops on one line, never the session's own", async () => {
    const { world, pix, b, queue } = forkLab();
    const a1 = await queue("Build it");
    const asg = world.assignments.require(a1);
    expect(chainBlock(world, asg)).toContain(`This is the first session on this work (chain ${a1}).`);
    expect(chainBlock(world, asg)).toContain(CHAIN_PLAN_RULE);
    expect(workPrompt(asg, undefined, undefined, chainBlock(world, asg))).not.toContain("This is your first session.");
    const report = (title: string, assignmentId: string, body: string, sessionId?: string) => createDoc(world, {
      type: "report", state: "building", title, body, verdict: "continue", authorId: pix.id, authorKind: "agent", buildingId: b.id, assignmentId, ...(sessionId ? { sessionId } : {}),
    });
    const r1 = report("Hop one", a1, "## Findings\nfirst plan");
    const a2 = createAssignment(world, { agentId: pix.id, title: "Hop two", description: "d", createdBy: { kind: "system", id: "system" }, fromReportId: r1.id, queue: "building" });
    expect(a2.chainId).toBe(a1);
    const r2 = report("Hop two done", a2.id, "## Findings\nsecond plan: do X, then Y");
    const a3 = createAssignment(world, { agentId: pix.id, title: "Hop three", description: "d", createdBy: { kind: "system", id: "system" }, fromReportId: r2.id, queue: "building" });
    const block = chainBlock(world, a3);
    expect(block).toContain(`This work continues chain ${a1} (2 reports so far)`);
    expect(block).toContain(`"Hop two done" by Pix (${r2.id}, verdict continue`);
    expect(block).toContain("second plan: do X, then Y");
    expect(block).not.toContain("first plan");
    expect(block).toContain(`Earlier on this chain (oldest first): "Hop one" (${r1.id}, verdict continue).`);
    // a desk brief is composed after its session started: that session's own report is left out
    report("Hop three (this session)", a3.id, "mine", "se_this");
    expect(chainBlock(world, a3, "se_this")).toContain("second plan");
    expect(chainBlock(world, a3)).toContain("mine");
  });
});

describe("manager forks: what the web shows (step 5)", () => {
  it("reportChain gives hop and previous report; forkSummary and forksOf list a manager's live and retired forks", async () => {
    const { world, pix, ann, b, queue } = forkLab();
    const a1 = await queue("Build it");
    const f1 = forkManager(world, b.id, a1).fork;
    world.ops.startSession(f1.id, { purpose: "work", model: "m", assignmentId: a1 });
    const r1 = createDoc(world, { type: "report", state: "building", title: "Hop one", body: "b", verdict: "continue", authorId: f1.id, authorKind: "agent", buildingId: b.id, assignmentId: a1 });
    retireFork(world, f1.id, { reportId: r1.id });
    const a2 = createAssignment(world, { agentId: pix.id, title: "Hop two", description: "d", createdBy: { kind: "system", id: "system" }, fromReportId: r1.id, queue: "building" });
    const f2 = forkManager(world, b.id, a2.id).fork;
    const r2 = createDoc(world, { type: "report", state: "building", title: "Hop two done", body: "b", verdict: "continue", authorId: f2.id, authorKind: "agent", buildingId: b.id, assignmentId: a2.id });
    expect(reportChain(world, r1)).toMatchObject({ chainId: a1, hop: 1, prevReportId: null });
    expect(reportChain(world, r2)).toMatchObject({ chainId: a1, hop: 2, prevReportId: r1.id });
    // only fork-authored reports get a chain badge
    const own = createDoc(world, { type: "report", state: "building", title: "Ann's", body: "b", authorId: ann.id, authorKind: "agent", buildingId: b.id, assignmentId: a1 });
    expect(Object.keys(reportChains(world, [r1, r2, own])).sort()).toEqual([r1.id, r2.id].sort());
    const s = forkSummary(world, world.agents.require(f2.id))!;
    expect(s).toMatchObject({ forkOfName: "Pix", assignmentId: a2.id, assignmentTitle: "Hop two", chainId: a1, hop: 2, reportId: r2.id, pagesEdited: [] });
    expect(forkSummary(world, pix)).toBeNull();
    const list = forksOf(world, pix.id);
    expect(list.live.map((f) => f.agent.name)).toEqual([f2.name]);
    expect(list.retired.map((f) => f.agent.id)).toEqual([f1.id]);
    expect(list.retired[0]).toMatchObject({ reportId: r1.id, hop: 1 });
  });

  it("familySpend sums the manager and its live and retired forks, today and all-time, as the Bank booked them", async () => {
    const { world, pix, ann, b, queue } = forkLab();
    const a1 = await queue("One"), a2 = await queue("Two");
    const f1 = forkManager(world, b.id, a1).fork;
    retireFork(world, f1.id, {});
    const f2 = forkManager(world, b.id, a2).fork;
    const set = world.db.prepare("UPDATE agents SET spentTokensToday = ?, spentTokensTotal = ?, spentUsdTotal = ? WHERE id = ?");
    set.run(100, 1000, 1.5, pix.id); set.run(0, 400, 0.5, f1.id); set.run(30, 30, 0.25, f2.id); set.run(7, 7, 7, ann.id);
    expect(familySpend(world, pix.id)).toEqual({ today: 130, forksToday: 30, cap: 3000, total: 1430, usdTotal: 2.25, forks: 2 });
    expect(forksOf(world, pix.id).family).toEqual({ today: 130, forksToday: 30, cap: 3000, total: 1430, usdTotal: 2.25, forks: 2 });
    // forks keep their own rows: the sum reads them, it books nothing
    expect(world.agents.require(f2.id).spentTokensTotal).toBe(30);
    expect(familySpend(world, ann.id)).toEqual({ today: 7, forksToday: 0, cap: 3000, total: 7, usdTotal: 7, forks: 0 });
  });

  it("a retired fork's booked spend stays in the family's today, and forks that died before a session don't crowd the retired list (as_v969ocjeol)", async () => {
    const { world, pix, b, queue } = forkLab(); // family cap 3 × 1000
    const a1 = await queue("Worked");
    const f1 = forkManager(world, b.id, a1).fork;
    world.ops.startSession(f1.id, { purpose: "work", model: "m", assignmentId: a1 });
    world.budget.recordUsage(f1.id, 250, 0.5);
    retireFork(world, f1.id, {});
    world.budget.recordUsage(pix.id, 40, 0.1);
    // a burst of forks whose desk failed at startup: retired with no session and no spend
    for (let i = 0; i < 3; i++) {
      const a = await queue(`Dead ${i}`);
      retireFork(world, forkManager(world, b.id, a).fork.id, {});
    }
    expect(world.agents.require(pix.id).familySpentToday).toBe(290);
    const list = forksOf(world, pix.id);
    expect(list.family).toMatchObject({ today: 290, forksToday: 250, cap: 3000, forks: 4 });
    expect(list.family.today).toBe(world.agents.require(pix.id).familySpentToday);
    expect(list.retired.map((f) => f.agent.id)).toEqual([f1.id]);
    expect(list.notStarted).toBe(3);
  });
});

describe("manager forks: the manager's team block (step 6)", () => {
  it("lists live forks and the building queue and routes by topic pages, not by resident wiki", async () => {
    const { world, pix, b, queue } = forkLab();
    const a1 = await queue("One"), a2 = await queue("Two");
    const { fork } = forkManager(world, b.id, a1);
    world.db.prepare("UPDATE assignments SET heldReason = ? WHERE id = ?").run("grant at checkpoint", a2);
    const t = teamBlock(world, world.buildings.require(b.id), pix.id);
    expect(t).toContain("Attach the topic pages that cover it");
    expect(t).toContain(`${fork.name} (${fork.id}): `);
    expect(t).toContain(`chain ${a1} · hop 1`);
    expect(t).not.toContain("whose wiki covers");
    expect(t).toContain(`- Pix 1 (${fork.id}): `);
    expect(t).toContain("Building queue (0 pending, 1 held, 0 waiting, 0 resuming at a time)");
    expect(t).toContain(`- ${a2} "Two": held: grant at checkpoint`);
  });
});
