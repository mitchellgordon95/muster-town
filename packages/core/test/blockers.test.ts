/** Why a queued assignment can't start (Mitchell's 1:1 mt_ryw7ejayvu): blockedBy on each, townBlocked for the map. */
import { describe, expect, it } from "vitest";
import { blockedBy, buildingRoleId, buildingStats, newId, nowIso, createSchedule, townBlocked, waitsOnTime } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const REPORT = "## What I did\nx\n\n## Findings\ny\n\n## What I need from you\nNothing needed.";

describe("blockedBy", () => {
  it("waits: a colleague's assignment (line to them), a deploy (the building's door, with the live sha), a decision (the in-tray); a time (parked work) is not a block", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei"), noor = by("Noor");
    world.host.commit = "abcdef1234567";
    const first = world.ops.createWork(admin, noor.id, { title: "Noor's step 2" });
    const onNoor = world.ops.createWork(admin, mei.id, { title: "Step 4", waitFor: { assignment: first.id } });
    const onDeploy = world.ops.createWork(admin, mei.id, { title: "Check live", waitFor: { deploy: "8842a21" } });
    const onNext = world.ops.createWork(admin, mei.id, { title: "After restart", waitFor: { deploy: "next" } });
    const at = new Date(Date.now() + 60 * 60_000).toISOString();
    const later = world.ops.createWork(admin, mei.id, { title: "Later", waitFor: { after: at } });
    expect(blockedBy(world, onNoor)).toEqual({ kind: "assignment", targetId: first.id, agentId: noor.id, text: `waits on assignment "Noor's step 2" (Noor)` });
    world.ops.startSession(noor.id, { purpose: "work", model: "m", assignmentId: first.id });
    const rep = await world.verbs.submit_report(noor, { title: "Noor R", body: REPORT, verdict: "stop" });
    const onReview = world.ops.createWork(admin, mei.id, { title: "After review", waitFor: { decision: rep.id } });

    expect(blockedBy(world, onDeploy)).toEqual({ kind: "deploy", targetId: "8842a21", placeId: `door:${onDeploy.buildingId}`, text: "waits for deploy 8842a21 (live is abcdef1)" });
    expect(blockedBy(world, onNext)?.text).toBe("waits for the next redeploy (live is abcdef1)");
    expect(blockedBy(world, later)).toBeNull();
    expect(waitsOnTime(later)).toBe(at);
    expect(blockedBy(world, onReview)).toEqual({ kind: "decision", targetId: rep.id, placeId: `intray:${world.docs.require(rep.id).buildingId}`, text: 'waits for a decision on "Noor R"' });

    // met waits are not blockers, even before checkWaits clears them; neither is plain queued work
    expect(blockedBy(world, world.ops.createWork(admin, mei.id, { title: "Plain" }))).toBeNull();
    expect(world.assignments.require(first.id).status).toBe("done"); // Noor's report finished it
    expect(blockedBy(world, world.assignments.require(onNoor.id))).toBeNull();

    const town = townBlocked(world);
    expect(town[mei.id]!.map((x) => x.title)).toEqual(["Check live", "After restart", "After review"]);
    expect(town[noor.id]).toBeUndefined();
  });

  it("a wait on a time (work parked with resumeWhen {after}) is not a block, before or after the time", () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    const late = world.ops.createWork(admin, mei.id, { title: "Late", waitFor: { after: new Date(Date.now() + 120 * 60_000).toISOString() } });
    world.ops.createWork(admin, mei.id, { title: "On deploy", waitFor: { deploy: "next" } });
    const after = new Date(Date.now() + 3 * 3600_000);
    expect(waitsOnTime(late, after)).toBeNull();
    expect(blockedBy(world, late)).toBeNull();
    expect(blockedBy(world, late, after)).toBeNull();
    expect(Object.values(townBlocked(world)).flat().map((x) => x.title)).toEqual(["On deploy"]);
  });

  it("buildingStats (town planning's side bar): running, queued (blocked among them), the building's active schedules; agents, forks, working; the live build", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei"), noor = by("Noor");
    world.host.commit = "abcdef1234567"; world.host.startedAt = "2026-10-29T16:30:00.000Z";
    const first = world.ops.createWork(admin, noor.id, { title: "Running" });
    world.ops.startSession(noor.id, { purpose: "work", model: "m", assignmentId: first.id });
    world.ops.createWork(admin, mei.id, { title: "Plain" });
    world.ops.createWork(admin, mei.id, { title: "On deploy", waitFor: { deploy: "next" } });
    world.ops.createWork(admin, mei.id, { title: "Later", waitFor: { after: new Date(Date.now() + 3600_000).toISOString() } });
    createSchedule(world, mei.homeBuildingId!, world.holderOf(admin), { title: "Nightly", description: "check", repeat: { dailyAt: ["20:00"] } });
    const s = buildingStats(world, mei.homeBuildingId!);
    expect(s.assignments).toEqual({ running: 1, queued: 3, blocked: 1, scheduled: 1 });
    const residents = world.agents.where("homeBuildingId = ? AND kind = 'resident' AND status NOT IN ('retired', 'banned')", [mei.homeBuildingId!]);
    expect(s).toMatchObject({ agents: residents.length, forks: 0, host: { commit: "abcdef1234567", startedAt: "2026-10-29T16:30:00.000Z" } });
    expect(s.working).toBe(residents.filter((a) => a.status === "working").length);
    expect(buildingStats(world, "town-hall").assignments).toEqual({ running: 0, queued: 0, blocked: 0, scheduled: 0 });
  });

  it("lane holds point at the Town Hall in-tray: grant at checkpoint, exploration allowance spent (used of allowance, reset time)", () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei"), noor = by("Noor");
    const kr = world.grantDesk.createKeyResult(admin, LAB, { text: "A visitor sees the spend", howToCheck: "Open the banner" });
    world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id, explorationTokensPerDay: 6_385_714 });
    world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
    const g = world.grantDesk.decide(admin, world.grantDesk.propose(mei, world.grantDesk.create(mei, LAB, { keyResultId: kr.id, objective: "o", stopCondition: "s", askTokens: 1_000_000 }).id).id, { action: "fund" });
    const grantWork = world.ops.createWork(admin, noor.id, { title: "Grant step", lane: "grant", grantId: g.id });
    const ex = world.ops.createWork(admin, noor.id, { title: "Explore", lane: "exploration", gap: "gap" });
    expect(blockedBy(world, grantWork)).toBeNull();
    expect(blockedBy(world, ex)).toBeNull();

    world.grants.patch(g.id, { status: "checkpoint" });
    world.sessions.upsert({
      id: newId("se"), agentId: noor.id, assignmentId: null, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
      sdkSessionId: null, output: 9_387_488, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "exploration", grantId: null,
    });
    const th = world.buildings.first("kind = 'town-hall'")!;
    expect(blockedBy(world, grantWork)).toEqual({ kind: "grant", targetId: g.id, placeId: `intray:${th.id}`, text: `grant ${g.id} at checkpoint` });
    expect(blockedBy(world, ex)).toEqual({ kind: "exploration", targetId: LAB, placeId: `intray:${th.id}`, text: "exploration allowance spent (9.4M of 6.4M today, resets at 00:00 UTC)" });
    // read-only: the stored heldReason is the scheduler's, not touched here
    expect(world.assignments.require(ex.id).heldReason).toBeNull();
  });
});
