/** 1:1 mt_peubjyoo0k: work a decider gives a forking manager (a meeting decision, a review's continue/redirect) lands on its building's queue. */
import { describe, expect, it } from "vitest";
import { buildingQueue, createAssignment, createBuilding, createDoc, createResident, decisionQueue, endMeeting, forkManager, updateBuilding } from "../src/index.ts";
import { creditBank, seededWorld } from "./helpers.ts";

function lab() {
  const s = seededWorld();
  const { world, seed } = s;
  const b = createBuilding(world, { name: "Forky", headcount: 3, dailyTokensPerAgent: 1000, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  const ann = createResident(world, { buildingId: b.id, name: "Ann" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world);
  world.budget.donate(seed.admin.id, { tokens: 1_000_000, buildingId: b.id });
  const meeting = () => world.ops.createMeeting(null, { kind: "standup", buildingId: b.id, title: "s", startNow: true });
  const report = (authorId: string) => createDoc(world, { type: "report", state: "building", title: "r", body: "## Proposal for next session\n\nDo the next thing.", decision: "pending", authorId, authorKind: "agent", buildingId: b.id });
  return { ...s, b, pix: world.agents.require(pix.id), ann, meeting, report };
}

describe("decisions naming a forking manager go to the building queue", () => {
  it("a meeting decision naming the manager: building queue, the line says so, the manager's own reports stay pending", () => {
    const { world, b, pix, meeting, report } = lab();
    expect(decisionQueue(world, pix.id)?.building.id).toBe(b.id);
    const own = report(pix.id);
    const m = meeting();
    const d = world.ops.meetingDecide(null, m.id, [{ text: "Fix the outbox", assigneeId: pix.id, assignmentId: null }]).decisions[0];
    expect(d.queueBuildingId).toBe(b.id);
    expect(world.assignments.require(d.assignmentId!)).toMatchObject({ agentId: pix.id, queue: "building" });
    expect(buildingQueue(world, b.id).map((a) => a.id)).toEqual([d.assignmentId]);
    expect(world.docs.require(own.id).decision).toBe("pending");
    const notes = world.docs.require(endMeeting(world, null, m.id).notesDocId!);
    expect(notes.body).toContain("1. Fix the outbox → Forky queue (a fork of Pix)");
  });

  it("amending a decision a fork is running amends it instead of refusing", () => {
    const { world, b, pix, meeting } = lab();
    const m = meeting();
    const d = world.ops.meetingDecide(null, m.id, [{ text: "One", assigneeId: pix.id, assignmentId: null }]).decisions[0];
    const { fork } = forkManager(world, b.id, d.assignmentId!);
    world.assignments.patch(d.assignmentId!, { status: "active" });
    const after = world.ops.meetingDecide(null, m.id, [{ text: "One, amended", assigneeId: pix.id, assignmentId: null, supersedes: 1 }]).decisions[1];
    expect(after).toMatchObject({ assignmentId: d.assignmentId, queueBuildingId: b.id });
    expect(world.assignments.require(d.assignmentId!)).toMatchObject({ agentId: fork.id, title: "One, amended" });
  });

  it("a decision naming anyone else is unchanged: a non-manager, a visitor manager", () => {
    const { world, ann, meeting, seed } = lab();
    const m = meeting();
    const d = world.ops.meetingDecide(null, m.id, [{ text: "Ann does it", assigneeId: ann.id, assignmentId: null }]).decisions[0];
    expect(d.queueBuildingId).toBeUndefined();
    expect(world.assignments.require(d.assignmentId!)).toMatchObject({ agentId: ann.id, queue: "agent" });

    const v = world.ops.registerVisitor(seed.admin.id, { name: "Vis" }).agent;
    const goal = world.goalTree.create(null, { parentId: "gl_town", text: "Orphan" });
    for (const g of world.buildings.all()) if (g.kind === "lab" && g.goalId === "gl_town") world.goalTree.attach(null, g.id, world.goalTree.create(null, { parentId: "gl_town", text: `P ${g.id}` }).id);
    world.ops.adoptGoal(v.id, goal.id);
    expect(decisionQueue(world, v.id)).toBeNull();
  });

  it("review continue/redirect on the manager's own report: building queue; on another author's report: unchanged", async () => {
    const { world, b, pix, ann, report, admin } = lab();
    const r1 = await world.verbs.review(admin, { docId: report(pix.id).id, decision: "continue", note: "" });
    expect(r1).toMatchObject({ queue: "building", to: "Forky queue (a fork of Pix)" });
    expect(world.assignments.require(r1.assignmentId!)).toMatchObject({ agentId: pix.id, queue: "building", buildingId: b.id });
    const r2 = await world.verbs.review(admin, { docId: report(pix.id).id, decision: "redirect", note: "Do this instead" });
    expect(world.assignments.require(r2.assignmentId!).queue).toBe("building");
    const r3 = await world.verbs.review(admin, { docId: report(ann.id).id, decision: "continue", note: "" });
    expect(world.assignments.require(r3.assignmentId!)).toMatchObject({ agentId: ann.id, queue: "agent" });
  });

  it("createAssignment routes by building: work naming a forking manager goes on its building queue, whoever names it", () => {
    const { world, b, pix, ann } = lab();
    const lane = { lane: "directed" as const, grantId: null, keyResultId: null, gap: null, sourceId: null };
    const by = { kind: "system" as const, id: "system" };
    // any caller (a wake, a human's assign or POST /work, a schedule takerId, a retry) names the manager: a fork runs it
    expect(createAssignment(world, { agentId: pix.id, createdBy: by, laneOverride: lane, title: "Message from Mitchell", description: "d" }).queue).toBe("building");
    // there is no "manager's own job" any more (step 2): even with its building given, it is the building's
    expect(createAssignment(world, { agentId: pix.id, buildingId: b.id, front: true, createdBy: by, laneOverride: lane, title: "Answer the counter on X", description: "d" }).queue).toBe("building");
    // anyone else keeps it on its own queue
    expect(createAssignment(world, { agentId: ann.id, createdBy: by, laneOverride: lane, title: "t", description: "d" }).queue).toBe("agent");
  });
});
