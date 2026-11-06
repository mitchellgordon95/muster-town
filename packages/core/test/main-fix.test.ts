/**
 * A red main gets one fixer (gr_7op2v8fjcl step 2, kr_hsfxuz8tnx; docs/invariants/runtime-wakes.md invariant 11):
 * exactly one fix assignment per red sha, routed to the red commit's author's building (else the fallback), and the
 * brief and `look` name the fixer only while main is red.
 */
import { describe, expect, it } from "vitest";
import type { MainCi } from "../src/index.ts";
import { buildingRoleId, composeWorkBrief, createBuilding, createResident, queueMainFix } from "../src/index.ts";
import { mainRedLine } from "../src/main-fix.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const RED: MainCi = { state: "red", sha: "aaaa111aaaa111aaaa111aaaa111aaaa111aaaa1", failedStep: "check", since: "2026-11-04T18:00:00.000Z", fixer: null, checkedAt: "2026-11-04T18:00:00.000Z" };

function setup() {
  const s = seededWorld();
  const { world, by, admin, seed } = s;
  creditBank(world);
  const mei = by("Mei");
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant(mei, buildingRoleId(LAB, "manager"));
  // the fallback building (Code Legibility in the live town), with a resident manager and a funded red-main grant
  const code = createBuilding(world, { name: "Code" }, seed.admin.id);
  const mara = createResident(world, { buildingId: code.id, name: "Mara", title: "t", direction: "d" });
  world.ops.updateBuilding(admin, code.id, { managerAgentId: mara.id });
  world.permissions.grant(mara, buildingRoleId(code.id, "manager"));
  const g = world.grantDesk.decide(admin, world.grantDesk.propose(mara, world.grantDesk.create(mara, code.id, { keyResults: [{ text: "one fixer", howToCheck: "the queue" }], objective: "o", steps: [{ title: "Step 1", description: "Do the work" }], stopCondition: "s", askTokens: 500_000 }).id).id, { action: "fund" });
  const opts = { fallbackBuildingId: code.id, grantId: g.id };
  return { ...s, mei, mara, code, grantId: g.id, opts };
}

const fixes = (world: ReturnType<typeof setup>["world"]) => world.assignments.where("createdBy = 'main-ci'");

describe("a red main gets one fixer (gr_7op2v8fjcl step 2)", () => {
  it("one fix assignment per red sha: repeated polls and a restart (the record re-read from the world) don't duplicate it", () => {
    const { world, mei, opts } = setup();
    const commit = { slug: "mei", author: "Mei <mei@muster-town.local>", runUrls: ["https://github.com/o/r/actions/runs/1/job/2"] };
    const once = queueMainFix(world, RED, commit, opts);
    expect(fixes(world)).toHaveLength(1);
    expect(once).toMatchObject({ fixSha: RED.sha, fixer: mei.id, fixAssignmentId: fixes(world)[0].id });
    expect(world.town.mainCi()).toMatchObject({ fixSha: RED.sha, fixAssignmentId: once.fixAssignmentId });
    queueMainFix(world, once, commit, opts);
    queueMainFix(world, world.town.mainCi()!, commit, opts); // a restart starts from the kept record
    expect(fixes(world)).toHaveLength(1);
    const a = fixes(world)[0];
    expect(a.description).toContain(RED.sha);
    expect(a.description).toContain("https://github.com/o/r/actions/runs/1/job/2");
    expect(a.description).toContain("check");

    // a new red sha while the fix is still open: the same fixer covers it (no race); once it ended, a new red sha gets one
    const next = queueMainFix(world, { ...world.town.mainCi()!, sha: "bbbb222" }, commit, opts);
    expect(fixes(world)).toHaveLength(1);
    expect(next).toMatchObject({ fixSha: "bbbb222", fixAssignmentId: a.id });
    world.assignments.patch(a.id, { status: "done" });
    queueMainFix(world, { ...next, sha: "cccc333" }, commit, opts);
    expect(fixes(world)).toHaveLength(2);
  });

  it("routes to the red commit author's building, else to the fallback; lane grant there", () => {
    const { world, mei, code, grantId, opts } = setup();
    const lab = queueMainFix(world, RED, { slug: "mei", author: "Mei", runUrls: [] }, opts);
    const a = world.assignments.require(lab.fixAssignmentId!);
    expect(a).toMatchObject({ buildingId: LAB, agentId: mei.id, queue: "building", lane: "directed" });

    world.assignments.patch(a.id, { status: "done" });
    const nobody = queueMainFix(world, { ...lab, sha: "bbbb222" }, { slug: null, author: "Mitchell Gordon", runUrls: [] }, opts);
    const b = world.assignments.require(nobody.fixAssignmentId!);
    expect(b).toMatchObject({ buildingId: code.id, queue: "building", lane: "grant", grantId });
    expect(b.description).toContain("falls back");

    world.assignments.patch(b.id, { status: "done" });
    const stranger = queueMainFix(world, { ...nobody, sha: "cccc333" }, { slug: "no-such-agent", author: "x", runUrls: [] }, opts);
    expect(world.assignments.require(stranger.fixAssignmentId!).buildingId).toBe(code.id);
  });

  it("the brief and look name the fixer only while main is red", async () => {
    const { world, mei, opts } = setup();
    let ci: MainCi | undefined = { ...RED, state: "green", failedStep: null };
    world.host.mainCi = () => ci;
    expect(mainRedLine(world)).toBeNull();
    expect((await world.verbs.look(mei, {})).notices.mainRed).toBeUndefined();

    ci = RED;
    expect(mainRedLine(world)).toContain("Fixer: none yet");
    ci = queueMainFix(world, RED, { slug: "mei", author: "Mei", runUrls: [] }, opts);
    const line = mainRedLine(world, Date.parse("2026-11-04T18:20:00Z"))!;
    expect(line).toContain("Main is red: CI failed on aaaa111 (check) since 2026-11-04 18:00 UTC (20 min ago)");
    expect(line).toContain(`(${ci.fixAssignmentId})`);
    expect((await world.verbs.look(mei, {})).notices.mainRed).toContain("Main is red");

    const s = world.ops.startSession(mei.id, { purpose: "work", model: "m", backend: "docker" });
    expect(composeWorkBrief(world, s.id).prompt).toContain("Main is red: CI failed");
    ci = { ...ci, state: "green", failedStep: null };
    expect(composeWorkBrief(world, s.id).prompt).not.toContain("Main is red: CI failed"); // the queue (a manager's first message) still lists the fix assignment
    expect((await world.verbs.look(mei, {})).notices.mainRed).toBeUndefined();
  });
});
