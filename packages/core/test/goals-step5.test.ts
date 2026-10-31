import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLANNER_UNPAID, REORG_PREP_MS, buildingRoleId, createBuilding, createUser, facilitateMaterial, intrayWorker, managerAgentOf, setMeetingPhase, endMeeting } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const due = "2026-12-31";

/** Mei manages the lab, attached under a goal with an open (funded) key result; "Other" has no manager. */
function setup() {
  const s = seededWorld();
  const { world, by, admin } = s;
  const mei = by("Mei");
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
  const tree = world.goalTree;
  const goal = tree.create(admin, { parentId: "gl_trust", text: "A funder sees what every token bought" });
  tree.attach(admin, LAB, goal.id);
  const kr = tree.addKeyResult(admin, goal.id, { text: "Grant panel lists sessions", howToCheck: "Open a grant", due, buildingId: LAB });
  const g = world.grantDesk.create(null, LAB, { keyResultId: kr.id, objective: "o", approach: "a", stopCondition: "s", askTokens: 1000 });
  world.grantDesk.propose(null, g.id);
  world.grantDesk.decide(admin, g.id, { action: "fund" });
  return { ...s, mei, tree, goal, kr, grant: g };
}

describe("Change this goal (docs/goals.md, step 5)", () => {
  it("filing X → Y: a human note, one directed prep assignment per attached building, under-review KRs, a Planner-facilitated meeting at the deadline", () => {
    const { world, admin, mei, goal, kr } = setup();
    expect(() => world.reorgs.file(mei, goal.id, { toText: "Y", why: "w" })).toThrow(/Only a human/);
    const c = world.reorgs.file(admin, goal.id, { toText: "Every token is accounted for", why: "the Bank refactor landed" });
    expect(c).toMatchObject({ goalId: goal.id, fromText: goal.text, status: "prep" });
    expect(Date.parse(c.meetingDeadline) - Date.parse(c.createdAt)).toBe(REORG_PREP_MS);
    const note = world.docs.require(c.sourceDocId!);
    expect(note).toMatchObject({ authorKind: "user", state: "building", buildingId: "town-hall" });
    const prep = world.assignments.where("sourceId = ?", [note.id]);
    expect(prep).toHaveLength(1);
    expect(prep[0]).toMatchObject({ buildingId: LAB, lane: "directed", queue: "building", agentId: mei.id });
    expect(prep[0].description).toContain(`reorgId ${c.id}`);
    expect(world.keyResults.require(kr.id).underReviewSince).toBeTruthy();
    expect(world.grants.first("keyResultId = ?", [kr.id])?.status).toBe("funded"); // grants keep running
    const planner = world.reorgs.planner()!;
    expect(planner).toMatchObject({ name: "Planner", homeBuildingId: "town-hall", kind: "resident" });
    const m = world.meetings.require(c.meetingId!);
    // the Bank is empty, so the Planner can't run here: the manager in the room facilitates
    expect(world.reorgs.canRun()).toBe(false);
    expect(m).toMatchObject({ kind: "planning", buildingId: null, phase: "scheduled", facilitatorId: mei.id, attendeeIds: [planner.id, mei.id], scheduledAt: c.meetingDeadline });
    expect(c.prep).toEqual([expect.objectContaining({ buildingId: LAB, status: "waiting" })]);
    // one open change per goal
    expect(() => world.reorgs.file(admin, goal.id, { toText: "Z", why: "w" })).toThrow(/already has a change/);
    expect(world.goalTree.history(goal.id).some((e) => e.type === "goal.changed")).toBe(true);
  });

  it("the meeting opens early once every prep report is in; its start sets the new words, its end decides the change", () => {
    const { world, admin, mei, goal } = setup();
    const c = world.reorgs.file(admin, goal.id, { toText: "Every token is accounted for", why: "w" });
    world.reorgs.tick();
    expect(world.meetings.require(c.meetingId!).scheduledAt).toBe(c.meetingDeadline);
    const a = world.assignments.first("sourceId = ?", [c.sourceDocId!])!;
    const report = world.docs.upsert({ ...world.docs.require(c.sourceDocId!), id: "dc_prepreport", type: "report", authorId: mei.id, authorKind: "agent", title: "prep", assignmentId: a.id });
    world.assignments.upsert({ ...a, status: "done", reportId: report.id });
    const now = new Date();
    world.reorgs.tick(now);
    expect(world.meetings.require(c.meetingId!).scheduledAt).toBe(now.toISOString());
    expect(world.reorgs.view(world.reorgs.get(c.id)!).prep[0]).toMatchObject({ status: "in", reportId: report.id });
    // a Town Hall allocation pays the Planner: it takes the meeting over as it opens
    world.budget.donate(world.users.all()[0].id, { tokens: 100_000, buildingId: "town-hall", auth: "api-key" });
    expect(world.reorgs.canRun()).toBe(true);
    setMeetingPhase(world, c.meetingId!, "discussing");
    expect(world.meetings.require(c.meetingId!).facilitatorId).toBe(world.reorgs.planner()!.id);
    expect(world.goalTree.get(goal.id)?.text).toBe("Every token is accounted for");
    expect(world.reorgs.get(c.id)?.status).toBe("meeting");
    expect(facilitateMaterial(world, world.meetings.require(c.meetingId!))).toContain(`reorg meeting of "Change this goal" ${c.id}`);
    endMeeting(world, null, c.meetingId!);
    expect(world.reorgs.get(c.id)).toMatchObject({ status: "decided" });
    expect(world.reorgs.get(c.id)?.decidedAt).toBeTruthy();
  });

  it("a goal with no attached building opens its meeting at once", () => {
    const { world, admin } = setup();
    const lonely = world.goalTree.create(admin, { parentId: "gl_join", text: "Nobody here" });
    const c = world.reorgs.file(admin, lonely.id, { toText: "Still nobody", why: "w" });
    expect(c.prep).toEqual([]);
    expect(world.meetings.require(c.meetingId!).scheduledAt).toBe(c.createdAt);
  });

  it("proposals carry reorgId; under-review key results are kept, moved or archived by a human", async () => {
    const { world, admin, mei, goal, kr, tree } = setup();
    const other = createBuilding(world, { name: "Other", goalId: goal.id }, null);
    const k2 = tree.addKeyResult(admin, goal.id, { text: "k2", howToCheck: "h", due, buildingId: other.id });
    const k3 = tree.addKeyResult(admin, goal.id, { text: "k3", howToCheck: "h", due, buildingId: LAB });
    const c = world.reorgs.file(admin, goal.id, { toText: "Y words", why: "w" });
    expect(c.prep.find((p) => p.buildingId === other.id)?.status).toBe("no-manager");
    const r = await world.verbs.propose_key_result(mei, { text: "New KR", howToCheck: "h", due, why: "fits Y", reorgId: c.id });
    expect(world.goalProposals.require(r.proposal.id).reorgId).toBe(c.id);
    await expect(world.verbs.propose_goal(mei, { action: "add-goal", parentId: goal.id, text: "x", why: "y", reorgId: "gc_nope" })).rejects.toThrow(/not a "Change this goal"/);
    expect(world.reorgs.view(world.reorgs.get(c.id)!).proposals).toEqual([r.proposal.id]);
    expect(() => world.reorgs.reviewKr(mei, kr.id, { action: "keep" })).toThrow(/Only a human/);
    world.reorgs.reviewKr(admin, kr.id, { action: "keep" });
    expect(world.keyResults.require(kr.id).underReviewSince).toBeNull();
    expect(() => world.reorgs.reviewKr(admin, kr.id, { action: "keep" })).toThrow(/not under review/);
    world.reorgs.reviewKr(admin, k2.id, { action: "move", goalId: "gl_join" });
    expect(world.keyResults.require(k2.id)).toMatchObject({ goalId: "gl_join", underReviewSince: null });
    world.reorgs.reviewKr(admin, k3.id, { action: "archive" });
    expect(world.keyResults.require(k3.id)).toMatchObject({ status: "missed", underReviewSince: null });
    expect(world.keyResults.require(k3.id).archivedAt).toBeTruthy();
  });
});

describe("Plan with an agent (docs/goals.md, step 5)", () => {
  it("opens a 1:1 with the Planner at the Town Hall, scoped to a goal; the Planner proposes for no building", async () => {
    const { world, admin, goal, mei } = setup();
    const m = world.reorgs.openPlanner(admin, goal.id);
    const planner = world.reorgs.planner()!;
    expect(m).toMatchObject({ kind: "one-on-one", buildingId: "town-hall", facilitatorId: planner.id, phase: "discussing" });
    expect(m.transcript[0].text).toContain(`(${goal.id})`);
    // an empty Bank: it can't run, and the 1:1 says so, once
    expect(m.transcript[1]).toMatchObject({ speakerKind: "system", text: PLANNER_UNPAID });
    // the same 1:1 comes back, and neither line is repeated
    expect(world.reorgs.openPlanner(admin, goal.id).id).toBe(m.id);
    expect(world.meetings.require(m.id).transcript).toHaveLength(2);
    const brief = world.reorgs.plannerBrief(world.meetings.require(m.id))!;
    expect(brief).toContain("You are the Planner");
    expect(brief).toContain(goal.id);
    expect(brief).not.toContain("gl_fund"); // scoped to the goal it started from
    // opened again from another goal: the same 1:1, now about that goal
    expect(world.reorgs.openPlanner(admin, "gl_fund").id).toBe(m.id);
    expect(world.reorgs.plannerBrief(world.meetings.require(m.id))).toContain(`under the goal they started from (gl_fund)`);
    // only the Planner at the Town Hall; members without goals.edit can't plan
    // the Town Hall's 1:1 is the Planner's (its manager): the same one; no other Town Hall agent takes one
    expect(world.ops.openOneOnOne(admin, "town-hall").id).toBe(m.id);
    expect(() => world.ops.openOneOnOne(admin, "town-hall", { agentId: world.agents.first("kind = 'service'")!.id })).toThrow();
    const stranger = world.ops.ensureAvatar(createUser(world, "Stranger").user.id);
    expect(() => world.reorgs.openPlanner(stranger, goal.id)).toThrow(/Only an admin or a goal's captain/);
    const p = await world.verbs.propose_goal(planner, { action: "add-goal", parentId: goal.id, text: "Sub-goal", why: "drafted with the human" });
    expect(world.goalProposals.require(p.proposal.id)).toMatchObject({ buildingId: null, proposedBy: planner.id });
    // a proposal can be presented in the 1:1 as a card
    world.verbs.meeting(planner, { meetingId: m.id, action: "speak", text: "Drafted it.", attach: p.proposal.id });
    expect(world.meetings.require(m.id).transcript.at(-1)?.attachment).toMatchObject({ kind: "page", ref: `goal-proposal:${p.proposal.id}` });
    expect(world.reorgs.plannerBrief(world.meetings.require(world.ops.openOneOnOne(admin, "carbon-cycle", { agentId: mei.id }).id))).toBeNull();
  });

  it("the Planner is the Town Hall's manager in name only: no manager agent for the in-tray, no manager role (1:1 mt_wql34b8gkl)", () => {
    const { world } = setup();
    const planner = world.reorgs.ensurePlanner();
    const th = world.buildings.require("town-hall");
    expect(th.managerAgentId).toBe(planner.id);
    expect(managerAgentOf(world, th)).toBeUndefined();
    expect(intrayWorker(world, th)).toBe("human");
    expect(world.permissions.can(planner, "building.review", "town-hall")).toBe(false);
    expect(world.permissions.can(planner, "town.redeploy")).toBe(false);
    // a Town Hall whose Planner predates it (prod): migration 066 back-fills, and ensurePlanner seats it too
    world.buildings.upsert({ ...th, managerAgentId: null });
    world.db.exec(readFileSync(join(import.meta.dirname, "..", "migrations", "066_planner_manages_town_hall.sql"), "utf8"));
    expect(world.buildings.require("town-hall").managerAgentId).toBe(planner.id);
    world.buildings.upsert({ ...world.buildings.require("town-hall"), managerAgentId: null });
    expect(world.reorgs.ensurePlanner().id).toBe(planner.id);
    expect(world.buildings.require("town-hall").managerAgentId).toBe(planner.id);
  });

  it("the Town Hall draws from the Bank like any building: the Planner runs, and its session debits the general balance (1:1 mt_cz11aqe81a)", () => {
    const { world, admin, goal, seed } = setup();
    world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: "m", tokens: 10_000, apiKey: "sk" });
    // one balance: the Town Hall sees what every building sees
    expect(world.bank.available("town-hall")).toEqual(world.bank.available(LAB));
    expect(world.bank.remaining("town-hall")).toBeGreaterThan(0);
    const m = world.reorgs.openPlanner(admin, goal.id);
    const planner = world.reorgs.planner()!;
    expect(world.reorgs.canRun()).toBe(true);
    expect(m.transcript.some((u) => u.text === PLANNER_UNPAID)).toBe(false);
    // a Planner session books to the Town Hall's pool, as a Workshop session books to its own
    const before = world.bank.available("town-hall").durable;
    world.budget.charge(planner.id, 400, 0);
    expect(world.bank.available("town-hall").durable).toBe(before - 400);
    expect(world.bank.available(LAB).durable).toBe(before - 400); // same pool, first come first served
    // and a reorg meeting is facilitated by the Planner, not the fallback manager
    const c = world.reorgs.file(admin, goal.id, { toText: "Y", why: "w" });
    expect(world.meetings.require(c.meetingId!).facilitatorId).toBe(planner.id);
  });
});
