/**
 * Jobs and entries, read only (plan dc_uwx045472m step 3; grant gr_9mp6v6vv8k kr_0neb2wqafu): every grant, retainer,
 * exploration chain, directed source and building has a job, back-filled with one entry per session report plus the
 * decisions on it; GET /api/jobs/:id (core `jobThread`) reads it; back-filling twice changes nothing.
 */
import { describe, expect, it } from "vitest";
import { applyDecision, buildingQueue, createBuilding, createResident, forkManager, jobThread, retireFork, updateBuilding } from "../src/index.ts";
import { backfillJobs, jobOf } from "../src/jobs.ts";
import { ruleBlock } from "../src/lanes.ts";
import { exploreTick } from "../src/explore.ts";
import { createAssignment } from "../src/domain.ts";
import type { World } from "../src/world.ts";

/** The job the back-fill's SQL gives an assignment (what GET /api/jobs/<assignment id> resolves to). */
const jobThreadId = (world: World, id: string) => jobThread(world, id)?.job.id ?? null;
import { creditBank, seededWorld } from "./helpers.ts";

const REPORT = "## What I did\nx\n## Findings\ny\n## What I need from you\nNothing needed.";
const STEPS = [
  { size: "M" as const, title: "Build it", description: "Ship the PR" },
  { size: "M" as const, title: "Check it live", description: "Open it as a guest" },
  { size: "M" as const, title: "Close it", description: "Measure and close" },
];

function lab() {
  const s = seededWorld();
  const { world, seed, admin } = s;
  const b = createBuilding(world, { name: "Jobby", headcount: 3, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world);
  const fund = () => {
    const g = world.grantDesk.propose(null, world.grantDesk.create(null, b.id, { keyResults: [{ text: "A banner", howToCheck: "Open the lab" }], objective: "A banner", approach: "a", steps: STEPS, stopCondition: "s", askTokens: 450_000 }).id);
    return world.grantDesk.decide(admin, g.id, { action: "fund" });
  };
  /** a fork takes the building's first queued assignment and files its report */
  const runNext = async (verdict: "continue" | "pivot" | "stop", extra: Record<string, unknown> = { left: "Two more steps." }) => {
    const a = buildingQueue(world, b.id)[0]!;
    const { fork } = forkManager(world, b.id, a.id);
    world.assignments.patch(a.id, { status: "active" });
    const r = await world.verbs.submit_report(fork, { title: `Report on ${a.title}`, body: REPORT, verdict, ...extra });
    retireFork(world, fork.id);
    return { a, r: world.docs.require(r.id) };
  };
  return { ...s, b: world.buildings.require(b.id), pix: world.agents.require(pix.id), fund, runNext };
}

describe("jobs and entries, read only", () => {
  it("a funded grant's job: rule ceiling, its history and one entry per step report, in order", async () => {
    const { world, fund, runNext, pix } = lab();
    const g = fund();
    const one = await runNext("continue");
    const two = await runNext("continue");
    const t = jobThread(world, g.id)!;
    expect(t.job).toMatchObject({ id: `jb_${g.id}`, rule: "ceiling", status: "open", pocketRef: g.id, closedAs: null });
    const reports = t.entries.filter((e) => e.docId && !e.answers);
    expect(reports.map((e) => e.docId)).toEqual([one.r.id, two.r.id]);
    expect(reports[0]).toMatchObject({ id: `en_${one.r.id}`, authorKind: "fork", assignmentId: one.a.id, proposes: "continue", moved: { stepsDone: [0], left: "Two more steps." }, pocket: g.id, level: "code" });
    expect(reports[1].moved).toEqual({ stepsDone: [1], left: "Two more steps." });
    // the human's propose and fund came first; seq is 1, 2, 3… in time order
    expect(t.entries.slice(0, 2).map((e) => e.moved.action)).toEqual(["propose", "fund"]);
    expect(t.entries[1].authorKind).toBe("human");
    expect(t.entries.map((e) => e.seq)).toEqual(t.entries.map((_, i) => i + 1));
    // an assignment id reads its job too
    expect(jobThread(world, one.a.id)!.job.id).toBe(`jb_${g.id}`);
    // a step that says continue with a step behind it is settled by the code: its answer is on the thread, written live
    const settled = jobThread(world, g.id)!.entries.find((e) => e.answers === `en_${one.r.id}`);
    expect(settled).toMatchObject({ authorKind: "code", moved: { decision: "approve" }, docId: one.r.id });
    expect(one.r.decision).toBe("approve");
    // the plan's last step waits for the manager; its decision answers the entry
    const three = await runNext("continue", { left: "Nothing." });
    expect(three.r.decision).toBe("pending");
    applyDecision(world, three.r.id, "approve", "", world.holderOf(pix));
    const answered = jobThread(world, g.id)!.entries.find((e) => e.answers === `en_${three.r.id}`);
    expect(answered).toMatchObject({ authorKind: "manager", moved: { decision: "approve" }, docId: three.r.id });
  });

  it("every building has a job; directed sources and exploration chains get their own; back-fill is idempotent", async () => {
    const { world, b, admin } = lab();
    for (const row of world.db.prepare("SELECT id FROM buildings").all() as { id: string }[]) {
      expect(jobThread(world, row.id)!.job).toMatchObject({ id: `jb_${row.id}`, rule: "building", status: "open" });
    }
    // a directed assignment from a human's source, and one from no source (the building's own thread)
    const pocketSource = "ms_testsource";
    const now = new Date().toISOString();
    const insert = world.db.prepare("INSERT INTO assignments (id, agentId, buildingId, title, description, status, createdBy, createdByKind, createdAt, updatedAt, lane, sourceId, chainId, reservationId) VALUES (?, ?, ?, ?, 'd', ?, ?, 'user', ?, ?, ?, ?, ?, ?)");
    insert.run("as_pocket1", b.managerAgentId, b.id, "Asked by a human", "done", admin.id, now, now, "directed", pocketSource, null, null);
    insert.run("as_chunk1", b.managerAgentId, b.id, "Explore the gap", "done", "system", now, now, "exploration", null, "as_chunk1", "rs_x");
    insert.run("as_chunk2", b.managerAgentId, b.id, "Explore, continued", "pending", "system", now, now, "exploration", null, "as_chunk1", "rs_x");
    expect(jobThread(world, "as_pocket1")!.job).toMatchObject({ id: `jb_${b.id}_${pocketSource}`, rule: "pocket", pocketRef: pocketSource, status: "closed", closedAs: "done" });
    expect(jobThread(world, "as_chunk2")!.job).toMatchObject({ id: "jb_as_chunk1", rule: "chunk", pocketRef: "rs_x", status: "open", title: "Explore the gap" });
    expect(jobThread(world, "nothing_here")).toBeNull();

    const count = () => (world.db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
    const seqs = () => world.db.prepare("SELECT id, jobId, seq FROM entries ORDER BY id").all();
    backfillJobs(world);
    const before = { n: count(), seqs: seqs() };
    expect(backfillJobs(world).entries).toBe(0);
    expect({ n: count(), seqs: seqs() }).toEqual(before);
  });

  it("a held grant reads as held; a closed one as closed with how", () => {
    const { world, fund, admin } = lab();
    const g = fund();
    world.grants.patch(g.id, { status: "checkpoint" });
    expect(jobThread(world, g.id)!.job.status).toBe("held");
    world.grantDesk.decide(admin, g.id, { action: "cut", note: "enough" });
    expect(jobThread(world, g.id)!.job).toMatchObject({ status: "closed", closedAs: "cut" });
    expect(jobThread(world, g.id)!.entries.at(-1)).toMatchObject({ authorKind: "human", moved: { action: "cut" }, note: "enough" });
  });
});

describe("submit_report writes the entry; budget rules replace the lanes (plan dc_uwx045472m step 4, gr_9mp6v6vv8k step 2)", () => {
  const entry = (world: ReturnType<typeof lab>["world"], docId: string) => {
    const r = world.db.prepare("SELECT * FROM entries WHERE id = ?").get(`en_${docId}`) as Record<string, unknown> | undefined;
    return r && { ...r, moved: JSON.parse(String(r.moved)) };
  };

  it("a proposal is a proposed ceiling job before anyone reads it; funding opens it", () => {
    const { world, b, admin } = lab();
    const g = world.grantDesk.propose(null, world.grantDesk.create(null, b.id, { keyResults: [{ text: "A banner", howToCheck: "Open the lab" }], objective: "A banner", approach: "a", steps: STEPS, stopCondition: "s", askTokens: 450_000 }).id);
    const row = () => world.db.prepare("SELECT status, rule, pocketRef FROM jobs WHERE id = ?").get(`jb_${g.id}`);
    expect(row()).toEqual({ status: "proposed", rule: "ceiling", pocketRef: g.id });
    world.grantDesk.decide(admin, g.id, { action: "fund" });
    expect(row()).toMatchObject({ status: "open" });
  });

  it("a step's report is written as its entry at submit time, with what it moved; without `left` it is refused, parked it is not", async () => {
    const { world, fund, runNext } = lab();
    const g = fund();
    const kr = g.keyResults[0]!;
    const a = buildingQueue(world, g.buildingId)[0]!;
    const { fork } = forkManager(world, g.buildingId, a.id);
    world.assignments.patch(a.id, { status: "active" });
    await expect(world.verbs.submit_report(fork, { title: "Step one", body: REPORT, verdict: "continue" })).rejects.toThrow(/what is left/);
    const filed = await world.verbs.submit_report(fork, { title: "Step one", body: REPORT, verdict: "continue", left: "Steps 2 and 3: check it live, then close.", keyResults: [{ id: kr.id, status: "on-track", evidence: "PR #1" }], topUp: { tokens: 10_000, buys: "the close" } });
    retireFork(world, fork.id);
    expect(filed.jobId).toBe(`jb_${g.id}`);
    const r = world.docs.require(filed.id);
    expect(entry(world, r.id)).toMatchObject({
      jobId: `jb_${g.id}`, authorKind: "fork", proposes: "continue", pocket: g.id, note: r.title,
      moved: { stepsDone: [0], left: "Steps 2 and 3: check it live, then close.", krClaimed: [{ id: kr.id, status: "on-track", evidence: "PR #1" }], topUp: { tokens: 10_000, buys: "the close" } },
    });
    // the back-fill keeps the live entry's moved
    backfillJobs(world);
    expect(entry(world, r.id)!.moved.left).toBe("Steps 2 and 3: check it live, then close.");
    // a parked step says nothing yet
    const parked = await runNext("continue", { resumeWhen: { after: new Date(Date.now() + 3600_000).toISOString() }, next: "go on" });
    expect(entry(world, parked.r.id)!.moved).toEqual({ stepsDone: [1] });
  });

  it("an explorer's chunk job is created with its assignment and closes when its reservation does", async () => {
    const { world, b } = lab();
    const r = world.bankReservations.upsert({ id: "rs_test1", goalId: world.goalTree.attachmentOf(b), buildingId: b.id, assignmentId: null, tokens: 50_000, openedAt: new Date().toISOString(), closedAt: null, spentTokens: null });
    const a = createAssignment(world, { agentId: b.managerAgentId!, buildingId: b.id, createdBy: { kind: "system", id: r.id }, title: "Explore", description: "x", lane: { lane: "exploration", gap: "a gap" }, reservationId: r.id });
    world.bankReservations.upsert({ ...r, assignmentId: a.id });
    const job = () => world.db.prepare("SELECT status, closedAs, rule, pocketRef FROM jobs WHERE id = ?").get(`jb_${a.id}`);
    expect(job()).toEqual({ status: "open", closedAs: null, rule: "chunk", pocketRef: r.id });
    const { fork } = forkManager(world, b.id, a.id);
    world.assignments.patch(a.id, { status: "active" });
    const rep = await world.verbs.submit_report(fork, { title: "Nothing worth a grant", body: REPORT, verdict: "stop" });
    expect(rep.jobId).toBe(`jb_${a.id}`);
    expect(entry(world, rep.id)).toMatchObject({ jobId: `jb_${a.id}`, pocket: r.id, proposes: "stop" });
    expect(job()).toMatchObject({ status: "closed", closedAs: "nothing-found" });
    exploreTick(world);
    expect(world.bankReservations.require(r.id).closedAt).not.toBeNull();
    expect(job()).toMatchObject({ status: "closed" });
  });

  it("ruleBlock keys the hold by the job's rule: a grant at its ceiling and an exploration past its cap still hold", () => {
    const { world, b, fund } = lab();
    const g = fund();
    const step = buildingQueue(world, b.id)[0]!;
    expect(jobOf(step)).toEqual({ id: `jb_${g.id}`, rule: "ceiling", pocketRef: g.id });
    world.grants.patch(g.id, { status: "checkpoint" });
    expect(ruleBlock(world, step)).toMatchObject({ kind: "grant", grantId: g.id, reason: "held: grant at checkpoint" });
    const ex = { ...step, id: "as_ex", grantId: null, keyResultId: null, lane: "exploration" as const, chainId: "as_ex", gap: "g", reservationId: null };
    expect(jobOf(ex)).toEqual({ id: "jb_as_ex", rule: "chunk", pocketRef: null });
    const cap = { goalId: "gl_x", tokensPerDay: 1, spentTodayTokens: 5 };
    const desk = world.grantDesk;
    const real = desk.exploration.bind(desk);
    desk.exploration = (id: string) => ({ ...real(id), freeTokens: 1_000_000, cap });
    try { expect(ruleBlock(world, ex)).toMatchObject({ kind: "exploration", reason: expect.stringMatching(/exploration cap reached today/) }); }
    finally { desk.exploration = real; }
  });

  it("jobOf agrees with the back-fill's SQL for every assignment", () => {
    const { world, b, admin, fund } = lab();
    const g = fund();
    const now = new Date().toISOString();
    const insert = world.db.prepare("INSERT INTO assignments (id, agentId, buildingId, title, description, status, createdBy, createdByKind, createdAt, updatedAt, lane, sourceId, chainId, reservationId, grantId) VALUES (?, ?, ?, 't', 'd', 'done', ?, 'user', ?, ?, ?, ?, ?, ?, ?)");
    insert.run("as_j1", b.managerAgentId, b.id, admin.id, now, now, "directed", "ms_src", "as_j1", null, null);
    insert.run("as_j2", b.managerAgentId, b.id, admin.id, now, now, "directed", null, "as_j2", null, null);
    insert.run("as_j3", b.managerAgentId, b.id, admin.id, now, now, "exploration", null, "as_j0", "rs_y", null);
    insert.run("as_j5", b.managerAgentId, b.id, admin.id, now, now, "grant", null, "as_j5", null, g.id);
    for (const id of ["as_j1", "as_j2", "as_j3", "as_j5"]) expect(jobOf(world.assignments.require(id)).id).toBe(jobThreadId(world, id));
  });
});
