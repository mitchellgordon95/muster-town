/** Forks step 2 friction 1 (dc_6tsgcif8r1): a live fork of the manager inherits the Town Hall board; nothing else (town.redeploy is human-only since 1:1 mt_vdu3iqhasi). */
import { describe, expect, it } from "vitest";
import { canPostTownBoard, createBuilding, createDoc, createResident, forkManager, townRoleId, updateBuilding } from "../src/index.ts";
import { creditBank, musterWorld } from "./helpers.ts";

const TOWN_HALL_ID = "town-hall";

function forkLab() {
  const s = musterWorld();
  const { world, seed } = s;
  const b = createBuilding(world, { name: "Forky", headcount: 3, dailyTokensPerAgent: 1000, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix", sprite: 5 });
  const ann = createResident(world, { buildingId: b.id, name: "Ann" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world);
  world.budget.donate(seed.admin.id, { tokens: 1_000_000, buildingId: b.id });
  const manager = world.agents.require(pix.id);
  world.permissions.grant(manager, townRoleId("deployer"));
  return { ...s, b, pix: manager, ann };
}

async function forkOf(lab: ReturnType<typeof forkLab>) {
  const { world, pix, b } = lab;
  const { assignmentId } = await world.verbs.assign(pix, { title: "Ship it", description: "d", gap: "test gap" });
  return forkManager(world, b.id, assignmentId).fork;
}

describe("fork permissions: what a fork inherits from its manager", () => {
  it("no agent redeploys (1:1 mt_vdu3iqhasi): not a manager with the deployer role, not its fork; a human admin does", async () => {
    const lab = forkLab();
    const { world, pix, ann, seed } = lab;
    const fork = await forkOf(lab);
    for (const a of [pix, fork, ann]) expect(world.permissions.can(a, "town.redeploy")).toBe(false);
    expect("redeploy" in world.verbs).toBe(false);
    expect(world.permissions.can({ kind: "user", id: seed.admin.id }, "town.redeploy")).toBe(true);
    world.host.hosted = true;
    expect(world.permissions.can({ kind: "user", id: seed.admin.id }, "town.redeploy")).toBe(false);
  });

  it("a fork posts an FYI to the Town Hall board and to its own building's board", async () => {
    const lab = forkLab();
    const { world, ann, b } = lab;
    const fork = await forkOf(lab);
    expect(canPostTownBoard(world, fork)).toBe(true);
    const town = await world.verbs.write(fork, { type: "fyi", title: "town rule", body: "x", state: "building", buildingId: TOWN_HALL_ID });
    expect(world.docs.require(town.id)).toMatchObject({ type: "fyi", state: "building", buildingId: TOWN_HALL_ID });
    const own = await world.verbs.write(fork, { type: "fyi", title: "lab note", body: "x", state: "building" });
    expect(world.docs.require(own.id)).toMatchObject({ type: "fyi", state: "building", buildingId: b.id });
    await expect(world.verbs.write(ann, { type: "fyi", title: "nope", body: "x", state: "building", buildingId: TOWN_HALL_ID })).rejects.toThrow(/Town Hall board/);
  });

  it("a fork still can't review, assign or manage: those stay with the manager", async () => {
    const lab = forkLab();
    const { world, ann, b } = lab;
    const fork = await forkOf(lab);
    for (const p of ["building.manage", "building.assign", "building.review", "building.fund"] as const) expect(world.permissions.can(fork, p, b.id)).toBe(false);
    const report = createDoc(world, { type: "report", state: "building", title: "r", body: "b", decision: "pending", authorId: ann.id, authorKind: "agent", buildingId: b.id });
    await expect(world.verbs.review(fork, { docId: report.id, decision: "approve" })).rejects.toThrow(/building\.review/);
    await expect(world.verbs.assign(fork, { agentId: ann.id, title: "x", description: "d", gap: "test gap" })).rejects.toThrow(/building\.assign/);
  });
});
