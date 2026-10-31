import { describe, expect, it } from "vitest";
import { buildingBoard, buildingRoleId, createAssignment, goalBoard, postmortemNote } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const due = "2026-12-31";

/** Mei manages the lab, attached under a goal with a funded key result. */
function setup() {
  const s = seededWorld();
  const { world, by, admin } = s;
  const mei = by("Mei");
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
  const tree = world.goalTree;
  const goal = tree.create(admin, { parentId: "gl_trust", text: "A funder sees what every token bought" });
  tree.attach(admin, LAB, goal.id);
  const g = world.grantDesk.create(null, LAB, { goalId: goal.id, keyResults: [{ text: "Grant panel lists sessions", howToCheck: "Open a grant", due }], objective: "o", approach: "a", stopCondition: "s", askTokens: 1000 });
  const kr = world.keyResults.require(g.keyResultId!);
  world.grantDesk.propose(null, g.id);
  world.grantDesk.decide(admin, g.id, { action: "fund" });
  return { ...s, mei, tree, goal, kr, grant: g };
}

describe("Postmortems on missed key results (docs/goals.md, step 6)", () => {
  it("missed asks why; the note queues one directed postmortem on the grant's building, and its report links back", async () => {
    const { world, admin, mei, kr } = setup();
    expect(() => world.grantDesk.updateKeyResult(admin, kr.id, { status: "missed" })).toThrow(/Say why/);
    world.grantDesk.updateKeyResult(admin, kr.id, { status: "missed", note: "The Bank refactor ate the quarter" });
    const note = postmortemNote(world, kr.id)!;
    expect(note).toMatchObject({ type: "note", authorKind: "user", state: "building", buildingId: LAB });
    expect(note.body).toContain("The Bank refactor ate the quarter");
    const [pm, ...more] = world.assignments.where("sourceId = ?", [note.id]);
    expect(more).toEqual([]);
    expect(pm).toMatchObject({ buildingId: LAB, lane: "directed", queue: "building", agentId: mei.id, status: "pending" });
    expect(pm.title).toContain(`Postmortem on ${kr.id}`);
    // undone and missed again: never a second postmortem
    world.grantDesk.updateKeyResult(admin, kr.id, { status: "not-started" });
    world.grantDesk.updateKeyResult(admin, kr.id, { status: "missed", note: "again" });
    expect(world.assignments.where("title LIKE ?", [`Postmortem on ${kr.id}%`])).toHaveLength(1);
    // the fork's report links back
    const missedAt = world.keyResults.require(kr.id).updatedAt;
    world.agents.patch(mei.id, { currentAssignmentId: pm.id });
    world.assignments.upsert({ ...pm, status: "active" });
    const r = await world.verbs.submit_report(mei, { title: "Postmortem", body: "## What I did\nx\n## Findings\ny\n## What I need from you\nNothing needed.", verdict: "stop" });
    const k = world.keyResults.require(kr.id);
    expect(k.postmortemDocId).toBe(r.id);
    expect(k.postmortemDocId).toBeTruthy();
    expect(k.updatedAt).toBe(missedAt);
    expect(world.docs.require(k.postmortemDocId!).tags).toContain("postmortem");
  });

  it("a key result archived as missed in a reorg gets one too; met gets none", () => {
    const { world, admin, goal, kr } = setup();
    const k2 = world.keyResults.require(world.grantDesk.create(null, LAB, { goalId: goal.id, keyResults: [{ text: "k2", howToCheck: "h", due }], objective: "o", stopCondition: "s", askTokens: 1000 }).keyResultId!);
    world.grantDesk.updateKeyResult(admin, k2.id, { status: "met" });
    expect(postmortemNote(world, k2.id)).toBeUndefined();
    world.reorgs.file(admin, goal.id, { toText: "Y words", why: "w" });
    world.reorgs.reviewKr(admin, kr.id, { action: "archive" });
    expect(postmortemNote(world, kr.id)).toBeTruthy();
  });
});

describe("Kanban: the queue as a board (docs/goals.md, step 6)", () => {
  it("Queued / Held / Running / Done per building; a goal rolls up its subtree's buildings", () => {
    const { world, admin, mei, goal } = setup();
    const by = { kind: "user" as const, id: admin.id };
    const q = createAssignment(world, { agentId: mei.id, queue: "building", buildingId: LAB, title: "queued one", description: "d", createdBy: by });
    const h = createAssignment(world, { agentId: mei.id, queue: "building", buildingId: LAB, title: "held one", description: "d", createdBy: by, waitFor: { deploy: "next" } });
    const r = createAssignment(world, { agentId: mei.id, queue: "building", buildingId: LAB, title: "running one", description: "d", createdBy: by });
    world.assignments.upsert({ ...r, status: "active" });
    const d = createAssignment(world, { agentId: mei.id, queue: "building", buildingId: LAB, title: "done one", description: "d", createdBy: by });
    world.assignments.upsert({ ...d, status: "done", updatedAt: new Date().toISOString() });
    const [lane] = buildingBoard(world, LAB).lanes;
    expect(lane.desks).toBe(world.buildings.require(LAB).headcount);
    expect(lane.queued.map((c) => c.id)).toContain(q.id);
    expect(lane.held.find((c) => c.id === h.id)?.heldReason).toBe("waits for the next redeploy");
    expect(lane.running.map((c) => c.id)).toEqual([r.id]);
    expect(lane.running[0].tokens).toBe(0);
    expect(lane.done.map((c) => c.id)).toContain(d.id);
    // done more than a day ago drops off
    world.assignments.upsert({ ...d, status: "done", updatedAt: new Date(Date.now() - 25 * 3600_000).toISOString() });
    expect(buildingBoard(world, LAB).lanes[0].done.map((c) => c.id)).not.toContain(d.id);
    expect(goalBoard(world, goal.id).lanes.map((l) => l.buildingId)).toEqual([LAB]);
    expect(goalBoard(world, "gl_trust").lanes.map((l) => l.buildingId)).toContain(LAB);
    expect(goalBoard(world, "gl_fund").lanes.map((l) => l.buildingId)).not.toContain(LAB);
  });
});
