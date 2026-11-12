/**
 * The job abstraction, step 1 (plan dc_uwx045472m, grant gr_9mp6v6vv8k): jobs and entries are read only, back-filled by
 * syncJobs from grants, retainers, exploration chunks, directed sources, buildings, report docs, report decisions and
 * grant history. Idempotent; a draft grant's job is not readable.
 */
import { describe, expect, it } from "vitest";
import { applyDecision, buildingQueue, createBuilding, createResident, forkManager, retireFork, updateBuilding } from "../src/index.ts";
import { jobThread, syncJobs } from "../src/jobs.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const REPORT = "## What I did\nx\n## Findings\ny\n## What I need from you\nNothing needed.";
const KR = { text: "A visitor sees the banner", howToCheck: "Open the lab" };
const STEPS = [
  { size: "M" as const, title: "Build the banner", description: "Ship the banner PR" },
  { size: "M" as const, title: "Check it live", description: "Open the lab as a guest" },
];

function lab() {
  const s = seededWorld();
  const { world, seed, admin } = s;
  const b = createBuilding(world, { name: "Jobby", headcount: 3, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world);
  const fund = () => world.grantDesk.decide(admin, world.grantDesk.propose(null, world.grantDesk.create(null, b.id, { keyResults: [KR], objective: "A banner", approach: "a", steps: STEPS, stopCondition: "s", askTokens: 500_000 }).id).id, { action: "fund" });
  const runStep = async (verdict: "continue" | "pivot" | "stop") => {
    const a = buildingQueue(world, b.id)[0]!;
    const { fork } = forkManager(world, b.id, a.id);
    world.assignments.patch(a.id, { status: "active" });
    const r = await world.verbs.submit_report(fork, { title: `Report on ${a.title}`, body: REPORT, verdict });
    retireFork(world, fork.id);
    return { a, fork, r };
  };
  return { ...s, b, pix, fund, runStep };
}

describe("jobs and entries, read only (plan step 3)", () => {
  it("a funded grant has a ceiling job with one entry per report, its decision answering it, and its history", async () => {
    const { world, b, pix, fund, runStep } = lab();
    const g = fund();
    const one = await runStep("continue");
    const two = await runStep("pivot");
    applyDecision(world, two.r.id, "approve", "seen", { kind: "agent", id: pix.id });
    syncJobs(world);

    const { job, entries } = jobThread(world, g.id);
    expect(job).toMatchObject({ rule: "ceiling", pocketRef: g.id, buildingId: b.id, status: "open", closedAs: null, title: world.grants.require(g.id).title });
    // reports: one entry each, by a fork, with the verdict, the tokens and the doc
    const reports = entries.filter((e) => e.ref === one.r.id || e.ref === two.r.id);
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ authorKind: "fork", authorId: one.fork.id, assignmentId: one.a.id, proposes: "continue", pocket: g.id, note: `Report on ${one.a.title}`, moved: { docId: one.r.id } });
    expect(reports[1]).toMatchObject({ proposes: "pivot", level: "none" });
    // the manager's approve on the second report answers its entry
    const decision = entries.find((e) => e.ref === `${two.r.id}#decision`)!;
    expect(decision).toMatchObject({ authorKind: "manager", authorId: pix.id, answers: reports[1]!.id, moved: { action: "approve" }, note: "approve: seen" });
    // grant history: propose (code: no actor), fund (the human)
    const history = entries.filter((e) => e.ref?.startsWith(`${g.id}#h`));
    expect(history.map((e) => e.moved.action)).toEqual(world.grants.require(g.id).history.map((h) => h.action));
    expect(history.find((e) => e.moved.action === "fund")).toMatchObject({ authorKind: "human", authorId: expect.stringMatching(/^us_/) });
    // seq is 1..n in time order
    expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i + 1));
    expect(entries.map((e) => e.createdAt)).toEqual([...entries.map((e) => e.createdAt)].sort());
  });

  it("is idempotent; a later sync adds only what is new and follows the grant's status", async () => {
    const { world, fund, runStep } = lab();
    const g = fund();
    syncJobs(world);
    const before = jobThread(world, g.id).entries.length;
    expect(syncJobs(world)).toEqual({ jobs: 0, entries: 0 });
    const r = await runStep("continue");
    world.grantDesk.close(null, g.id, { outcome: "done", note: "done" });
    const added = syncJobs(world);
    expect(added.jobs).toBe(0);
    const { job, entries } = jobThread(world, g.id);
    expect(entries.length).toBe(before + added.entries);
    expect(entries.some((e) => e.ref === r.r.id)).toBe(true);
    expect(job).toMatchObject({ status: "closed", closedAs: "done" });
  });

  it("every building has a building job; a pending report on it waits at level manager until decided", () => {
    const { world, b, pix } = lab();
    syncJobs(world);
    for (const bl of world.buildings.all()) expect(jobThread(world, bl.id).job).toMatchObject({ rule: "building", buildingId: bl.id, status: "open" });
    // a report with no assignment (a rollup, a town-written row) goes on the building job
    const doc = world.docs.upsert({ id: "dc_rollup1", type: "report", state: "building", title: "Rollup", body: "b", authorId: pix.id, authorKind: "agent", buildingId: b.id, decision: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as never);
    syncJobs(world);
    const e = jobThread(world, b.id).entries.find((x) => x.ref === doc.id)!;
    expect(e).toMatchObject({ authorKind: "manager", level: "manager" });
    applyDecision(world, doc.id, "approve", "", { kind: "agent", id: pix.id });
    syncJobs(world);
    expect(world.entries.require(e.id).level).toBe("none");
  });

  it("directed work with a human source is a pocket job; exploration is a chunk job; a draft grant's job is not found", () => {
    const { world, b, pix } = lab();
    const now = new Date().toISOString();
    const base = { agentId: pix.id, buildingId: b.id, description: "d", status: "done", createdBy: pix.id, createdByKind: "agent", createdAt: now, updatedAt: now };
    world.assignments.upsert({ ...base, id: "as_dir1", title: "Do what Mitchell said", lane: "directed", sourceId: "ms_human1" } as never);
    world.assignments.upsert({ ...base, id: "as_exp1", title: "Explore the gap", lane: "exploration", chainId: "as_exp1", status: "active" } as never);
    const draft = world.grantDesk.create(null, b.id, { keyResults: [KR], objective: "Draft", steps: STEPS, stopCondition: "s", askTokens: 1 });
    syncJobs(world);
    expect(jobThread(world, "ms_human1").job).toMatchObject({ rule: "pocket", buildingId: b.id, title: "Do what Mitchell said", status: "closed", closedAs: "done" });
    expect(jobThread(world, "as_exp1").job).toMatchObject({ rule: "chunk", status: "open" });
    expect(() => jobThread(world, draft.id)).toThrow(/job not found/);
    expect(() => jobThread(world, "jb_nope")).toThrow(/job not found/);
  });
});
