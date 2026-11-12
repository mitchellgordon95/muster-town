/**
 * Jobs and entries, read only (plan dc_uwx045472m step 3; grant gr_9mp6v6vv8k kr_0neb2wqafu): every grant, retainer,
 * exploration chain, directed source and building has a job, back-filled with one entry per session report plus the
 * decisions on it; GET /api/jobs/:id (core `jobThread`) reads it; back-filling twice changes nothing.
 */
import { describe, expect, it } from "vitest";
import { applyDecision, buildingQueue, createBuilding, createResident, forkManager, jobThread, retireFork, updateBuilding } from "../src/index.ts";
import { backfillJobs } from "../src/jobs.ts";
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
  const runNext = async (verdict: "continue" | "pivot" | "stop") => {
    const a = buildingQueue(world, b.id)[0]!;
    const { fork } = forkManager(world, b.id, a.id);
    world.assignments.patch(a.id, { status: "active" });
    const r = await world.verbs.submit_report(fork, { title: `Report on ${a.title}`, body: REPORT, verdict });
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
    expect(reports[0]).toMatchObject({ id: `en_${one.r.id}`, authorKind: "fork", assignmentId: one.a.id, proposes: "continue", moved: { stepsDone: [0] }, pocket: g.id, level: "manager" });
    expect(reports[1].moved).toEqual({ stepsDone: [1] });
    // the human's propose and fund came first; seq is 1, 2, 3… in time order
    expect(t.entries.slice(0, 2).map((e) => e.moved.action)).toEqual(["propose", "fund"]);
    expect(t.entries[1].authorKind).toBe("human");
    expect(t.entries.map((e) => e.seq)).toEqual(t.entries.map((_, i) => i + 1));
    // an assignment id reads its job too
    expect(jobThread(world, one.a.id)!.job.id).toBe(`jb_${g.id}`);
    // the manager's decision on a report answers its entry
    applyDecision(world, one.r.id, "approve", "", world.holderOf(pix));
    const answered = jobThread(world, g.id)!.entries.find((e) => e.answers === `en_${one.r.id}`);
    expect(answered).toMatchObject({ authorKind: "manager", moved: { decision: "approve" }, docId: one.r.id });
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
