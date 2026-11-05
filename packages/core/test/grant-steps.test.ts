/**
 * Grant B (gr_b5fyqibfx2): a proposal carries its steps; funding queues step 1 on the building queue (no manager kickoff
 * session, no fallback: 1:1 mt_stsjh68yz2 decision 1); a step's report queues the next one, a pivot nothing; the
 * manager's review stop / redirect cancels a queued next step; migration 096 back-fills open proposals with one step.
 */
import Database from "better-sqlite3";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyDecision, buildingQueue, reviewDeck, createBuilding, createDoc, createResident, forkManager, retireFork, updateBuilding } from "../src/index.ts";
import { migrate } from "../src/db.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const REPORT = "## What I did\nx\n## Findings\ny\n## What I need from you\nNothing needed.";
const KR = { text: "A visitor sees the banner", howToCheck: "Open the lab" };
const STEPS = [
  { title: "Build the banner", description: "Ship the banner PR", model: "claude-haiku-5-5" },
  { title: "Check it live", description: "Open the lab as a guest" },
  { title: "Close it", description: "Measure and close" },
];

function lab() {
  const s = seededWorld();
  const { world, seed, admin } = s;
  const b = createBuilding(world, { name: "Steppy", headcount: 3, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world);
  const page = createDoc(world, { type: "wiki", state: "building", title: "Banner", body: "b", authorId: pix.id, authorKind: "agent", buildingId: b.id, topicOf: b.id }, "page");
  const steps = STEPS.map((st, i) => (i === 0 ? { ...st, pages: [page.id] } : st));
  const propose = (over: Partial<{ steps: typeof steps }> = {}) =>
    world.grantDesk.propose(null, world.grantDesk.create(null, b.id, { keyResults: [KR], objective: "A banner", approach: "a", steps, stopCondition: "s", askTokens: 500_000, ...over }).id);
  const fund = (over: Partial<{ steps: typeof steps }> = {}) => world.grantDesk.decide(admin, propose(over).id, { action: "fund" });
  /** a fork takes the building's first queued assignment and files its report */
  const runStep = async (verdict: "continue" | "pivot" | "stop", resumeWhen?: { after: string }) => {
    const a = buildingQueue(world, b.id)[0]!;
    const { fork } = forkManager(world, b.id, a.id);
    world.assignments.patch(a.id, { status: "active" });
    const r = await world.verbs.submit_report(fork, { title: `Report on ${a.title}`, body: REPORT, verdict, ...(resumeWhen ? { resumeWhen, next: "resume" } : {}) });
    retireFork(world, fork.id);
    return { a, fork, r };
  };
  return { ...s, b: world.buildings.require(b.id), pix: world.agents.require(pix.id), page, propose, fund, runStep };
}

describe("grant B: funding queues step 1, no kickoff session", () => {
  it("fund puts step 1 on the building queue (lane grant, grantStep 0, its model and pages) and no manager assignment", () => {
    const { world, b, pix, page, fund } = lab();
    const g = fund();
    expect(world.grants.require(g.id).steps).toHaveLength(3);
    const q = buildingQueue(world, b.id);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ title: "Build the banner", queue: "building", agentId: pix.id, lane: "grant", grantId: g.id, keyResultId: g.keyResultId, grantStep: 0, model: "claude-haiku-5-5", pages: [page.id] });
    expect(q[0]!.description).toContain("step 1 of 3");
    expect(q[0]!.description).toContain("Ship the banner PR");
    // no kickoff: nothing on the manager's own queue, nothing titled "funded"
    expect(world.assignments.where("agentId = ? AND queue = 'agent'", [pix.id])).toHaveLength(0);
    expect(world.assignments.where("title LIKE '%funded%'", [])).toHaveLength(0);
  });

  it("propose refuses a proposal without steps; a step's model must be one the building runs and its pages topic pages of it", () => {
    const { world, b, propose } = lab();
    expect(() => world.grantDesk.create(null, b.id, { keyResults: [KR], objective: "o", stopCondition: "s", askTokens: 1 } as never)).toThrow();
    expect(() => propose({ steps: [] })).toThrow();
    expect(() => propose({ steps: [{ title: "t", description: "d", model: "claude-sonnet-5-5" }] })).toThrow(/Step 1: .*runs forks on/);
    expect(() => propose({ steps: [{ title: "t", description: "d", pages: ["dc_nope"] }] })).toThrow(/Step 1: .*topic page/);
    // a draft left with no steps (as before migration 096) can't be proposed
    const d = world.grantDesk.create(null, b.id, { keyResults: [KR], objective: "o", steps: [STEPS[1]!], stopCondition: "s", askTokens: 1 });
    world.grants.upsert({ ...world.grants.require(d.id), steps: [] });
    expect(() => world.grantDesk.propose(null, d.id)).toThrow(/1-5 steps/);
  });
});

describe("grant B: a step's report queues the next step", () => {
  it("continue queues step 2 from the report; the last step's report queues nothing", async () => {
    const { world, b, fund, runStep } = lab();
    const g = fund();
    const one = await runStep("continue");
    expect(one.r.nextStepId).toBeTruthy();
    const two = world.assignments.require(one.r.nextStepId!);
    expect(two).toMatchObject({ title: "Check it live", grantStep: 1, lane: "grant", grantId: g.id, queue: "building", fromReportId: one.r.id, fromAssignmentId: one.a.id, model: null });
    expect(one.r.note).toContain("next step");
    await runStep("stop"); // a stop verdict on a step means the step is done: the plan goes on
    expect(buildingQueue(world, b.id).map((a) => a.grantStep)).toEqual([2]);
    const last = await runStep("continue");
    expect(last.r.nextStepId).toBeNull();
    expect(buildingQueue(world, b.id)).toHaveLength(0);
  });

  it("a pivot verdict queues nothing: the manager's review decides", async () => {
    const { world, b, fund, runStep } = lab();
    fund();
    const { r } = await runStep("pivot");
    expect(r.nextStepId).toBeNull();
    expect(buildingQueue(world, b.id)).toHaveLength(0);
  });

  it("the manager's stop or redirect of a step's report cancels the queued next step; approve leaves it", async () => {
    const { world, b, pix, fund, runStep } = lab();
    fund();
    const one = await runStep("continue");
    const manager = { kind: "agent" as const, id: pix.id };
    applyDecision(world, one.r.id, "approve", "", manager);
    expect(world.assignments.require(one.r.nextStepId!).status).toBe("pending");
    const two = await runStep("continue");
    applyDecision(world, two.r.id, "redirect", "Do something else instead", manager);
    expect(world.assignments.require(two.r.nextStepId!).status).toBe("cancelled");

    const s = lab();
    s.fund();
    const first = await s.runStep("continue");
    applyDecision(s.world, first.r.id, "stop", "", { kind: "agent", id: s.pix.id });
    expect(s.world.assignments.require(first.r.nextStepId!).status).toBe("cancelled");
    expect(buildingQueue(world, b.id).filter((a) => a.grantStep != null)).toHaveLength(0); // the redirect's own assignment is not a step
    expect(buildingQueue(world, b.id).some((a) => a.title === "Do something else instead")).toBe(true);
  });

  it("a parked step stays the same step: its continuation keeps grantStep and its report queues the next", async () => {
    const { world, b, fund, runStep } = lab();
    fund();
    const parked = await runStep("continue", { after: new Date(Date.now() + 3_600_000).toISOString() });
    expect(parked.r.nextStepId).toBeNull();
    const cont = world.assignments.require(parked.r.nextAssignmentId!);
    expect(cont.grantStep).toBe(0);
    world.assignments.patch(cont.id, { waitFor: null });
    expect(buildingQueue(world, b.id).map((a) => a.id)).toEqual([cont.id]);
    const resumed = await runStep("continue");
    expect(world.assignments.require(resumed.r.nextStepId!).grantStep).toBe(1);
  });
});

describe("grant B step 2: the card and the deck show the steps (kr_snardl39qh)", () => {
  it("a proposal's view has its steps with no state; its deck slide lists them numbered", () => {
    const { world, propose } = lab();
    const p = propose();
    expect(world.grantDesk.get(p.id).stepStates).toEqual([null, null, null]);
    const slide = reviewDeck(world).slides.find((s) => s.key === `proposal:${p.id}`)!;
    expect(slide.text).toContain("**Steps** (funding queues step 1");
    expect(slide.text).toContain("1. Build the banner\n2. Check it live\n3. Close it");
  });

  it("once funded each step carries its latest assignment: done, queued, none yet", async () => {
    const { world, fund, runStep } = lab();
    const g = fund();
    expect(world.grantDesk.get(g.id).stepStates!.map((x) => x?.status ?? null)).toEqual(["pending", null, null]);
    const { a, r } = await runStep("continue");
    const st = world.grantDesk.get(g.id).stepStates!;
    expect(st[0]).toEqual({ assignmentId: a.id, status: "done", reportId: r.id });
    expect(st[1]?.status).toBe("pending");
    expect(st[2]).toBeNull();
  });
});

describe("migration 096: open proposals get one step, funded grants none", () => {
  it("back-fills draft, proposed and countered grants from their objective and approach; leaves funded and closed ones alone", () => {
    const MIGRATIONS = join(fileURLToPath(import.meta.url), "..", "..", "migrations");
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    cpSync(MIGRATIONS, dir, { recursive: true });
    rmSync(join(dir, "096_grant_steps.sql"));
    const db = new Database(":memory:");
    migrate(db, dir);
    const cols = (db.prepare("PRAGMA table_info(grants)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("steps");
    const ins = db.prepare(`INSERT INTO grants (id, buildingId, objective, approach, testingPlan, stopCondition, askTokens, status, findingsDocIds, checkpointsDone, history, proposedBy, createdAt, updatedAt)
      VALUES (?, 'b', ?, ?, '[]', 's', 1, ?, '[]', '[]', '[]', 'ag', '2026-11-05T00:00:00.000Z', '2026-11-05T00:00:00.000Z')`);
    ins.run("gr_draft", "Draft one", "Do it this way", "draft");
    ins.run("gr_prop", "Proposed one", "", "proposed");
    ins.run("gr_ctr", "Countered one", "Smaller", "countered");
    ins.run("gr_fund", "Funded one", "x", "funded");
    ins.run("gr_closed", "Closed one", "x", "closed");
    cpSync(join(MIGRATIONS, "096_grant_steps.sql"), join(dir, "096_grant_steps.sql"));
    migrate(db, dir);
    const steps = (id: string) => JSON.parse((db.prepare("SELECT steps FROM grants WHERE id = ?").get(id) as { steps: string }).steps);
    expect(steps("gr_draft")).toEqual([{ title: "Step 1: Draft one", description: "As in the approach: Do it this way" }]);
    expect(steps("gr_prop")).toEqual([{ title: "Step 1: Proposed one", description: "Carry out the plan: Proposed one" }]);
    expect(steps("gr_ctr")).toHaveLength(1);
    expect(steps("gr_fund")).toEqual([]);
    expect(steps("gr_closed")).toEqual([]);
    expect((db.prepare("PRAGMA table_info(assignments)").all() as { name: string }[]).map((c) => c.name)).toContain("grantStep");
  });
});
