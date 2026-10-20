/** Waiting design P1/P2: assignments that wait on a dependency, and agents parking their own work (submit_report resumeWhen). */
import { describe, expect, it } from "vitest";
import { WAIT_TTL_MS } from "@muster-town/schema";
import { checkWaits, nextPending, setAssignmentStatus } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const REPORT = "## What I did\nx\n\n## Findings\ny\n\n## What I need from you\nNothing needed.";

describe("assignments that wait (P1)", () => {
  it("the scheduler skips a waiting assignment until checkWaits finds it met; then it unblocks with an event", () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    const first = world.ops.createWork(admin, mei.id, { title: "First" });
    const later = world.ops.createWork(admin, mei.id, { title: "After First", waitFor: { assignment: first.id } });
    expect(later.waitFor).toEqual({ assignment: first.id });
    expect(nextPending(world, mei.id)!.id).toBe(first.id);
    setAssignmentStatus(world, first.id, "done");
    expect(nextPending(world, mei.id)).toBeUndefined(); // still waiting until the check runs
    expect(checkWaits(world).unblocked.map((a) => a.id)).toEqual([later.id]);
    expect(world.assignments.require(later.id).waitFor).toBeNull();
    expect(nextPending(world, mei.id)!.id).toBe(later.id);
    expect(world.events.recent({ limit: 5 }).some((e) => e.text.startsWith(`Mei's "After First" unblocked: Mei's "First" to finish`))).toBe(true);
  });

  it("deploy waits read the host: a sha via isLive, \"next\" once the server started after the assignment; none without a runtime", () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    const sha = world.ops.createWork(admin, mei.id, { title: "Check the Bank", waitFor: { deploy: "8842a21" } });
    const next = world.ops.createWork(admin, mei.id, { title: "After redeploy", waitFor: { deploy: "next" } });
    expect(checkWaits(world).unblocked).toEqual([]);
    world.host.isLive = (s) => s === "8842a21";
    world.host.startedAt = new Date(Date.now() + 1000).toISOString();
    expect(checkWaits(world).unblocked.map((a) => a.title).sort()).toEqual(["After redeploy", "Check the Bank"]);
    expect([sha, next].every((a) => world.assignments.require(a.id).waitFor === null)).toBe(true);
  });

  it("decision and after waits; validation refuses unknown targets and far-future times", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei"), noor = by("Noor");
    const work = world.ops.createWork(admin, noor.id, { title: "Noor's run" });
    world.ops.startSession(noor.id, { purpose: "work", model: "m", assignmentId: work.id });
    const rep = await world.verbs.submit_report(noor, { title: "Noor R", body: REPORT, verdict: "stop" });
    const onReview = await world.verbs.assign(admin, { agentId: mei.id, title: "After review", description: "d", waitFor: { decision: rep.id } });
    expect(onReview.waitingOn).toBe('a decision on "Noor R"');
    const soon = world.ops.createWork(admin, mei.id, { title: "Later", waitFor: { after: new Date(Date.now() + 60_000).toISOString() } });
    expect(checkWaits(world).unblocked).toEqual([]);
    await world.verbs.review(admin, { docId: rep.id, decision: "approve" });
    expect(checkWaits(world).unblocked.map((a) => a.id)).toEqual([onReview.assignmentId]);
    expect(checkWaits(world, new Date(Date.now() + 120_000)).unblocked.map((a) => a.id)).toEqual([soon.id]);

    expect(() => world.ops.createWork(admin, mei.id, { title: "x", waitFor: { assignment: "as_nope" } })).toThrow(/assignment/);
    expect(() => world.ops.createWork(admin, mei.id, { title: "x", waitFor: { after: new Date(Date.now() + 2 * WAIT_TTL_MS).toISOString() } })).toThrow(/24 h/);
    await expect(world.verbs.assign(admin, { agentId: mei.id, title: "x", description: "d", waitFor: { deploy: "not a sha" } as never })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("a wait unmet after 24 h is cancelled into the in-tray; Continue there queues it again without the wait", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    const a = world.ops.createWork(admin, mei.id, { title: "Never", waitFor: { deploy: "abcdef1" } });
    expect(checkWaits(world, new Date(Date.now() + WAIT_TTL_MS - 60_000)).expired).toEqual([]);
    const { expired } = checkWaits(world, new Date(Date.now() + WAIT_TTL_MS + 1000));
    expect(expired.map((x) => x.id)).toEqual([a.id]);
    expect(world.assignments.require(a.id).status).toBe("cancelled");
    const note = world.ops.intray("carbon-cycle").at(-1)!;
    expect(note.title).toBe("Mei's assignment never unblocked: Never");
    const r = await world.verbs.review(admin, { docId: note.id, decision: "continue" });
    expect(world.assignments.require(r.assignmentId!)).toMatchObject({ title: "Never", status: "pending", waitFor: null });
  });

  it("start next overrides the wait", () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    const a = world.ops.createWork(admin, mei.id, { title: "Waiting", waitFor: { deploy: "next" } });
    world.ops.startNext(admin, a.id);
    expect(world.assignments.require(a.id).waitFor).toBeNull();
    expect(nextPending(world, mei.id)!.id).toBe(a.id);
  });
});

describe("parking your own work (P2)", () => {
  async function parkedRun(resumeWhen: Record<string, string>, next = "Check the Bank is live") {
    const s = seededWorld();
    const mei = s.by("Mei");
    const work = s.world.ops.createWork(s.admin, mei.id, { title: "Build the Bank" });
    s.world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: work.id });
    const res = await s.world.verbs.submit_report(mei, { title: "Bank pushed", body: REPORT, verdict: "continue", resumeWhen: resumeWhen as never, next });
    return { ...s, mei, work, res };
  }

  it("submit_report with resumeWhen queues a parked continuation; it resumes by itself once met (approve keeps it parked)", async () => {
    const { world, mei, work, res, admin } = await parkedRun({ deploy: "8842a21" });
    expect(world.assignments.require(work.id).status).toBe("done");
    const cont = world.assignments.require(res.nextAssignmentId!);
    expect(cont).toMatchObject({ title: "Check the Bank is live", status: "pending", waitFor: { deploy: "8842a21" }, parked: 1, fromAssignmentId: work.id, fromReportId: res.id });
    expect(res.note).toContain("resumes by itself after a redeploy with 8842a21");
    expect(world.docs.require(res.id).tags).toContain("parked");
    expect(world.agents.require(mei.id).status).toBe("idle");
    expect(nextPending(world, mei.id)).toBeUndefined();
    await world.verbs.review(admin, { docId: res.id, decision: "approve" });
    world.host.isLive = () => true;
    checkWaits(world);
    expect(nextPending(world, mei.id)!.id).toBe(cont.id);
  });

  it("in the in-tray, Continue resumes it now, Redirect cancels it for the note, Stop cancels it", async () => {
    const c = await parkedRun({ deploy: "next" });
    const r = await c.world.verbs.review(c.admin, { docId: c.res.id, decision: "continue", note: "go now" });
    expect(r.assignmentId).toBe(c.res.nextAssignmentId);
    expect(c.world.assignments.require(r.assignmentId!)).toMatchObject({ waitFor: null, status: "pending" });
    expect(c.world.assignments.require(r.assignmentId!).description).toContain("go now");

    const d = await parkedRun({ deploy: "next" });
    const r2 = await d.world.verbs.review(d.admin, { docId: d.res.id, decision: "redirect", note: "Do X instead" });
    expect(d.world.assignments.require(d.res.nextAssignmentId!).status).toBe("cancelled");
    expect(d.world.assignments.require(r2.assignmentId!).title).toBe("Do X instead");

    const e = await parkedRun({ deploy: "next" });
    await e.world.verbs.review(e.admin, { docId: e.res.id, decision: "stop" });
    expect(e.world.assignments.require(e.res.nextAssignmentId!).status).toBe("cancelled");
  });

  it("a chain parks at most 3 times in a row", async () => {
    const { world, mei, res } = await parkedRun({ deploy: "next" });
    let cur = world.assignments.require(res.nextAssignmentId!);
    for (let i = 2; i <= 3; i++) {
      world.assignments.upsert({ ...cur, waitFor: null });
      world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: cur.id });
      const r = await world.verbs.submit_report(world.agents.require(mei.id), { title: `R${i}`, body: REPORT, verdict: "continue", resumeWhen: { deploy: "next" } });
      cur = world.assignments.require(r.nextAssignmentId!);
      expect(cur.parked).toBe(i);
    }
    world.assignments.upsert({ ...cur, waitFor: null });
    world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: cur.id });
    await expect(world.verbs.submit_report(world.agents.require(mei.id), { title: "R4", body: REPORT, verdict: "continue", resumeWhen: { deploy: "next" } })).rejects.toThrow(/parked 3 times/);
  });
});
