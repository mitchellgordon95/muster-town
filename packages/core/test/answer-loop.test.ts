/**
 * The one loop, live (plan dc_uwx045472m step 5; grant gr_9mp6v6vv8k step 3, kr_uncaesm191): every new entry is answered
 * at the lowest level that can settle it. A step that says continue queues the next step and is acknowledged by the
 * code; the manager's queue holds only what needs judgment; a session that died is a code entry the manager answers; a
 * flag opens its own pocket job; passing an entry up files the human's ask and the decision comes back on the thread.
 */
import { describe, expect, it } from "vitest";
import { buildingQueue, createBuilding, createResident, decideAsk, fileDeadSession, forkManager, intrayOf, jobThread, managerIntrayBlock, managerQueue, openManagerEntries, retireFork, setAssignmentStatus, updateBuilding } from "../src/index.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const body = (need: string) => `## What I did\nx\n## Findings\ny\n## What I need from you\n${need}`;
const QUIET = body("Nothing needed.");
const ASKS = body("Decide whether the banner is blue.");
const STEPS = [
  { size: "M" as const, title: "Build it", description: "Ship the PR" },
  { size: "M" as const, title: "Check it live", description: "Open it as a guest" },
];

function lab() {
  const s = seededWorld();
  const { world, seed, admin } = s;
  const b = createBuilding(world, { name: "Loopy", headcount: 3, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world);
  const fund = () => {
    const g = world.grantDesk.propose(null, world.grantDesk.create(null, b.id, { keyResults: [{ text: "A banner", howToCheck: "Open the lab" }], objective: "A banner", approach: "a", steps: STEPS, stopCondition: "s", askTokens: 300_000 }).id);
    return world.grantDesk.decide(admin, g.id, { action: "fund" });
  };
  /** a fork takes the building's first queued assignment */
  const take = () => {
    const a = buildingQueue(world, b.id)[0]!;
    const { fork } = forkManager(world, b.id, a.id);
    setAssignmentStatus(world, a.id, "active");
    world.agents.patch(fork.id, { currentAssignmentId: a.id });
    return { a, fork: world.agents.require(fork.id) };
  };
  const report = async (verdict: "continue" | "pivot" | "stop", text = QUIET, extra: Record<string, unknown> = { left: "One more step." }) => {
    const { a, fork } = take();
    const r = await world.verbs.submit_report(fork, { title: `Report on ${a.title}`, body: text, verdict, ...extra });
    retireFork(world, fork.id);
    return { a, r, doc: world.docs.require(r.id) };
  };
  return { ...s, b: world.buildings.require(b.id), pix: world.agents.require(pix.id), fund, take, report };
}

describe("the one loop: submit_report is answered at the lowest level that can settle it", () => {
  it("a step that says continue queues the next step with no manager approve, and never reaches the in-tray (kr_uncaesm191)", async () => {
    const { world, b, fund, report } = lab();
    const g = fund();
    const one = await report("continue");
    expect(one.r).toMatchObject({ decision: "approve", nextStepId: expect.any(String) });
    expect(one.r.note).toContain("nobody needs to decide it (the next step is queued)");
    expect(one.doc).toMatchObject({ decision: "approve", decidedBy: "system" });
    expect(one.doc.decisionNote).toBe("Settled by the town: the next step is queued.");
    expect(managerQueue(world, b.id)).toEqual([]);
    expect(buildingQueue(world, b.id).map((a) => a.title)).toEqual(["Check it live"]);
    // on the thread: the fork's entry at level code, answered by the code
    const t = jobThread(world, g.id)!.entries;
    const entry = t.find((e) => e.id === `en_${one.doc.id}`)!;
    expect(entry).toMatchObject({ authorKind: "fork", level: "code", proposes: "continue" });
    expect(t.find((e) => e.answers === entry.id)).toMatchObject({ authorKind: "code", authorId: "system", moved: { decision: "approve" } });
    // the back-fill writes neither of them a second time
    world.db.prepare("SELECT 1").get();
    expect(jobThread(world, g.id)!.entries.filter((e) => e.answers === entry.id)).toHaveLength(1);
  });

  it("the plan's last step, a pivot and a report that asks something wait for the manager", async () => {
    const { world, b, pix, fund, report } = lab();
    const g = fund();
    const asks = await report("continue", ASKS);
    expect(asks.doc.decision).toBe("pending");
    // the code still did its part: the next step is queued while the manager reads
    expect(buildingQueue(world, b.id).map((a) => a.title)).toEqual(["Check it live"]);
    expect(managerQueue(world, b.id).map((x) => x.id)).toEqual([asks.doc.id]);
    expect(jobThread(world, g.id)!.entries.find((e) => e.id === `en_${asks.doc.id}`)!.level).toBe("manager");
    await world.verbs.review(pix, { docId: asks.doc.id, decision: "approve", note: "blue" });
    const last = await report("continue", QUIET, { left: "Nothing." });
    expect(last.doc.decision).toBe("pending");
    expect(managerQueue(world, b.id).map((x) => x.id)).toEqual([last.doc.id]);
    expect(managerIntrayBlock(world, b, pix.id)).toContain(last.doc.id);
  });

  it("a pivot never queues the next step and is the manager's", async () => {
    const { world, b, fund, report } = lab();
    fund();
    const p = await report("pivot");
    expect(p.doc.decision).toBe("pending");
    expect(buildingQueue(world, b.id)).toEqual([]);
    expect(intrayOf(world, b.id).map((d) => d.id)).toEqual([p.doc.id]);
  });

  it("a parked report that asks nothing is settled by the code and still resumes by itself", async () => {
    const { world, b, fund, report } = lab();
    fund();
    const parked = await report("continue", QUIET, { resumeWhen: { after: new Date(Date.now() + 3_600_000).toISOString() }, next: "Check it in an hour" });
    expect(parked.doc).toMatchObject({ decision: "approve", decidedBy: "system" });
    expect(parked.r.nextAssignmentId).toBeTruthy();
    expect(world.assignments.require(parked.r.nextAssignmentId!)).toMatchObject({ status: "pending", grantStep: 0 });
    expect(managerQueue(world, b.id)).toEqual([]);
  });
});

describe("the one loop: a session that ended without a report", () => {
  const died = (world: ReturnType<typeof lab>["world"], t: ReturnType<ReturnType<typeof lab>["take"]>, stopped = false) => {
    const session = world.ops.startSession(t.fork.id, { purpose: "work", model: "m", assignmentId: t.a.id });
    return world.transaction(() => {
      const e = fileDeadSession(world, { session, assignment: world.assignments.require(t.a.id), buildingId: t.a.buildingId, agentName: t.fork.name, title: `Session ended without a report: ${t.a.title}`, body: "## Findings\nhalf a branch pushed", stopped, error: stopped ? null : "desk exited -1" });
      setAssignmentStatus(world, t.a.id, "cancelled", { heldReason: "The session ended without a report." });
      return e!;
    });
  };

  it("is a code entry on the job's thread for the manager, not a report doc; what is left is not asked of it (the bug behind as_0rk272gsne)", async () => {
    const { world, b, pix, fund, take } = lab();
    const g = fund();
    const t = take();
    const docs = world.docs.count("type = 'report' AND buildingId = ?", [b.id]);
    const e = died(world, t);
    expect(e).toMatchObject({ jobId: `jb_${g.id}`, authorKind: "code", level: "manager", docId: null, assignmentId: t.a.id, moved: { kind: "dead-session", stopped: false, error: "desk exited -1" } });
    expect(world.docs.count("type = 'report' AND buildingId = ?", [b.id])).toBe(docs);
    expect(openManagerEntries(world, b.id).map((x) => x.id)).toEqual([e.id]);
    expect(managerIntrayBlock(world, b, pix.id)).toMatch(new RegExp(`${e.id} SESSION ENDED WITHOUT A REPORT \\(Pix 1; error: desk exited -1\\) on jb_${g.id}`));
    expect(world.events.list({ buildingId: b.id, types: ["entry.created"], limit: 50 }).at(-1)!.payload).toMatchObject({ entryId: e.id, level: "manager" });
    // nothing is left active with no session behind it, and nothing waits on it for ever
    expect(world.assignments.require(t.a.id).status).toBe("cancelled");
    // the manager reads it like a report
    expect(await world.verbs.read(pix, { id: e.id })).toMatchObject({ id: e.id, body: expect.stringContaining("half a branch pushed"), job: { id: `jb_${g.id}`, rule: "ceiling" } });
  });

  it("review continue puts the same work back on the queue: same grant, same plan step, with what the session left", async () => {
    const { world, b, pix, fund, take, report } = lab();
    const g = fund();
    const t = take();
    const e = died(world, t);
    retireFork(world, t.fork.id);
    const res = await world.verbs.review(pix, { docId: e.id, decision: "continue", note: "run the suite in the foreground" });
    const again = world.assignments.require(res.assignmentId!);
    expect(again).toMatchObject({ status: "pending", queue: "building", lane: "grant", grantId: g.id, grantStep: 0, title: "Build it", fromAssignmentId: t.a.id });
    expect(again.description).toContain("Manager's note: run the suite in the foreground");
    expect(again.description).toContain("half a branch pushed");
    expect(openManagerEntries(world, b.id)).toEqual([]);
    expect(jobThread(world, g.id)!.entries.find((x) => x.answers === e.id)).toMatchObject({ authorKind: "manager", moved: { decision: "continue" } });
    // answered once
    await expect(world.verbs.review(pix, { docId: e.id, decision: "approve", note: "" })).rejects.toThrow(/already answered/);
    // the retried step's report queues the plan's next step, as the first try would have
    const done = await report("continue");
    expect(done.a.id).toBe(again.id);
    expect(buildingQueue(world, b.id).map((a) => a.title)).toEqual(["Check it live"]);
  });

  it("review redirect makes the note the work on the same grant; approve drops it; continue on a human's entry is refused", async () => {
    const { world, b, pix, admin, fund, take } = lab();
    const g = fund();
    const e = died(world, take());
    const res = await world.verbs.review(pix, { docId: e.id, decision: "redirect", note: "Split it: only the migration\nthen stop" });
    expect(world.assignments.require(res.assignmentId!)).toMatchObject({ title: "Split it: only the migration", lane: "grant", grantId: g.id, grantStep: null });
    world.grantDesk.stop(admin, g.id, { reason: "wrong direction" });
    const [stop] = openManagerEntries(world, b.id);
    expect(stop).toMatchObject({ authorKind: "human", moved: { kind: "decision", action: "stop" } });
    await expect(world.verbs.review(pix, { docId: stop!.id, decision: "continue", note: "" })).rejects.toThrow(/approve it once you have taken it in/);
    await world.verbs.review(pix, { docId: stop!.id, decision: "approve", note: "read" });
    expect(openManagerEntries(world, b.id)).toEqual([]);
  });

  it("a session someone stopped is a record: on the thread, not in the manager's queue", () => {
    const { world, b, fund, take } = lab();
    fund();
    const e = died(world, take(), true);
    expect(e).toMatchObject({ level: "none", moved: { stopped: true } });
    expect(openManagerEntries(world, b.id)).toEqual([]);
  });

  it("only who may review the building answers its entries", async () => {
    const { world, fund, take } = lab();
    fund();
    const e = died(world, take());
    const stranger = world.agents.first("homeBuildingId = 'carbon-cycle' AND kind != 'human'")!;
    await expect(world.verbs.review(stranger, { docId: e.id, decision: "approve", note: "" })).rejects.toThrow(/building\.review/);
  });
});

describe("the one loop: passing up, flags, closed grants", () => {
  it("pass up: the manager's card is the human's ask, the report leaves the in-tray, and the decision comes back on the thread for the manager", async () => {
    const { world, b, pix, admin, fund, report } = lab();
    const g = fund();
    const asks = await report("continue", ASKS);
    const ask = { type: "click" as const, title: "Make the banner blue?", body: "The fork has waited on this since today.\nBlue matches the door.", branches: [{ label: "Blue" }, { label: "Keep grey" }], recommendation: "Blue: it matches the door" };
    await expect(world.verbs.review(pix, { docId: asks.doc.id, decision: "continue", note: "", ask })).rejects.toThrow(/with decision approve/);
    const up = await world.verbs.review(pix, { docId: asks.doc.id, decision: "approve", note: "only Mitchell knows the colour", ask }) as { decision: string; askId: string };
    expect(up.decision).toBe("pass-up");
    expect(world.asks.require(up.askId)).toMatchObject({ status: "open", type: "click", buildingId: b.id, sourceDocId: asks.doc.id, title: "Make the banner blue?" });
    expect(world.docs.require(asks.doc.id).decision).toBe("approve");
    expect(managerQueue(world, b.id)).toEqual([]);
    const entry = () => jobThread(world, g.id)!.entries.find((e) => e.id === `en_${asks.doc.id}`)!;
    expect(entry().level).toBe("human");
    // the human decides the ask: their words are an entry on the same thread, at level manager
    decideAsk(world, admin, up.askId, "Blue", "and bold");
    const [back] = openManagerEntries(world, b.id);
    expect(back).toMatchObject({ jobId: `jb_${g.id}`, authorKind: "human", level: "manager", answers: entry().id, moved: { decision: "ask-decided" } });
    expect(back!.note).toContain("Blue. and bold");
    expect(managerIntrayBlock(world, b, pix.id)).toContain(`${back!.id} ANSWER TO YOUR ASK`);
    await world.verbs.review(pix, { docId: back!.id, decision: "redirect", note: "Paint the banner blue and bold" });
    expect(buildingQueue(world, b.id).map((a) => a.title)).toContain("Paint the banner blue and bold");
    expect(openManagerEntries(world, b.id)).toEqual([]);
  });

  it("pass up refuses a card without structure, and leaves the item where it was", async () => {
    const { world, b, pix, fund, report } = lab();
    fund();
    const asks = await report("continue", ASKS);
    await expect(world.verbs.review(pix, { docId: asks.doc.id, decision: "approve", note: "", ask: { type: "click", title: "Blue?", body: "", branches: [{ label: "Blue" }] } as never })).rejects.toThrow(/lacks/);
    expect(world.docs.require(asks.doc.id).decision).toBe("pending");
    expect(managerQueue(world, b.id).map((x) => x.id)).toEqual([asks.doc.id]);
    expect(world.asks.count("buildingId = ?", [b.id])).toBe(world.asks.count("buildingId = ? AND type = 'money'", [b.id]));
  });

  it("a flag opens its own pocket job: the human's entry first, the manager's delegation answers it, the work is charged to it", async () => {
    const { world, b, pix, admin } = lab();
    const flag = world.ops.plantFlag(admin, b.id, "Fix the banner typo\nit says 'teh'");
    const jobId = `jb_${b.id}_${flag.id}`;
    const t = jobThread(world, jobId)!;
    expect(t.job).toMatchObject({ rule: "pocket", status: "open", pocketRef: flag.id, title: "Fix the banner typo" });
    expect(t.entries).toHaveLength(1);
    expect(t.entries[0]).toMatchObject({ id: `en_${flag.id}`, authorKind: "human", level: "manager", docId: flag.id });
    world.docs.patch(flag.id, { pickedUpAt: new Date().toISOString(), pickedUpBy: pix.id });
    const res = await world.verbs.review(pix, { docId: flag.id, decision: "continue", note: "" });
    expect(world.assignments.require(res.assignmentId!)).toMatchObject({ lane: "directed", sourceId: flag.id });
    const after = jobThread(world, jobId)!;
    expect(after.entries.find((e) => e.answers === `en_${flag.id}`)).toMatchObject({ authorKind: "manager", moved: { decision: "continue" } });
    expect(jobThread(world, res.assignmentId!)!.job.id).toBe(jobId);
    expect(after.job.status).toBe("open");
  });

  it("closing a grant as done cancels the work still queued on it; the boot repair does it for grants closed before", async () => {
    const { world, b, admin, fund, report } = lab();
    const g = fund();
    await report("continue");
    const [queued] = buildingQueue(world, b.id);
    world.grantDesk.closeDone(admin, g.id, { note: "done early" });
    expect(world.assignments.require(queued!.id)).toMatchObject({ status: "cancelled", heldReason: "Grant closed: closed as done" });
    // one left pending by an older close (as_0rk272gsne on gr_9mp6v6vv8k)
    const stuck = world.assignments.upsert({ ...world.assignments.require(queued!.id), id: "as_stuck00001", status: "pending", heldReason: null });
    expect(world.grantDesk.cancelOrphanedWork()).toEqual([stuck.id]);
    expect(world.assignments.require(stuck.id).status).toBe("cancelled");
    expect(world.grantDesk.cancelOrphanedWork()).toEqual([]);
  });
});
