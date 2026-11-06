/**
 * One agent model (gr_a5ct690l7a, Mitchell's 1:1 mt_26vin80bpm): a fresh town's agents are exactly the Planner and one
 * named manager per lab. No town moderator, no building reviewer, no service agent, no standing residents.
 */
import { CollectiveConfig } from "@muster-town/schema";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildingRoleId, TOWN_HALL_ID } from "../src/index.ts";
import { freshWorld, tempDir } from "./helpers.ts";

const WORKSHOP = join(import.meta.dirname, "..", "..", "..", "collectives", "workshop", "collective.json");

describe("fresh seed", () => {
  it("the Workshop collective seeds the Planner plus one manager per building, and nothing else", () => {
    const { world } = freshWorld();
    const seed = world.seedDefaults({ collectivePath: WORKSHOP, townJsonPath: WORKSHOP });
    const labs = world.buildings.where("kind = 'lab'");
    expect(labs.length).toBeGreaterThan(0);
    const planner = world.reorgs.planner()!;
    expect(planner).toMatchObject({ homeBuildingId: TOWN_HALL_ID, kind: "resident" });
    expect(world.buildings.require(TOWN_HALL_ID).managerAgentId).toBe(planner.id);
    const managers = labs.map((b) => b.managerAgentId);
    expect(managers.every(Boolean)).toBe(true);
    expect(world.agents.all().map((a) => a.id).sort()).toEqual([planner.id, ...managers].sort());
    for (const b of labs) expect(world.permissions.agentsWithRole(buildingRoleId(b.id, "manager"))).toEqual([b.managerAgentId]);
    expect(world.roles.where("name IN ('reviewer', 'moderator')")).toEqual([]);
    // collective.json names the Workshop's manager and its town roles
    expect(seed.manager).toMatchObject({ name: "Pix", homeBuildingId: "workshop" });
    expect(world.permissions.can(seed.manager!, "town.redeploy")).toBe(true);
  });

  // collective.json `plans` (gr_qggxximtru, 1:1 mt_pr3347g2w2): the plan the collective pays for lands in "Plans paid for" at seed and on every later boot, once
  it("seeds collective.json's plans into Plans paid for, once, and never for a hosted collective", () => {
    const dir = tempDir();
    const path = join(dir, "collective.json");
    const cfg = { ...JSON.parse(readFileSync(WORKSHOP, "utf8")), workspace: undefined, plans: [{ label: "Max 20x", usdPerMonth: 200, from: "2026-10-25" }] };
    writeFileSync(path, JSON.stringify(cfg));
    const { world } = freshWorld();
    const seed = world.seedDefaults({ collectivePath: path, townJsonPath: path });
    expect(world.bank.fees()).toMatchObject([{ label: "Max 20x", usdPerMonth: 200, fromDate: "2026-10-25", toDate: null, paidBy: seed.admin.id }]);
    world.seedDefaults({ collectivePath: path, townJsonPath: path }); // the next boot
    expect(world.bank.fees()).toHaveLength(1);
    const hosted = freshWorld();
    hosted.world.host.hosted = true;
    hosted.world.seedDefaults({ collectivePath: path, townJsonPath: path });
    expect(hosted.world.bank.fees()).toEqual([]);
    // the Workshop's own file names its plan
    expect(CollectiveConfig.parse(JSON.parse(readFileSync(WORKSHOP, "utf8"))).plans.length).toBeGreaterThan(0);
  });

  it("collective.json carries no residents, reviewer or moderators keys", () => {
    const raw = JSON.parse(readFileSync(WORKSHOP, "utf8")) as { moderators?: unknown; buildings: Record<string, unknown>[] };
    expect(raw.moderators).toBeUndefined();
    for (const b of raw.buildings) {
      expect(b.residents).toBeUndefined();
      expect(b.reviewer).toBeUndefined();
      expect(b.headcount).toBeTypeOf("number");
    }
    expect(() => CollectiveConfig.parse(raw)).not.toThrow();
  });

  it("a building with no `manager` spec gets a town-named one", () => {
    const { world } = freshWorld();
    const cfg = join(tempDir(), "collective.json");
    writeFileSync(cfg, JSON.stringify({ name: "T", goal: "", buildings: [{ id: "lab", name: "Lab", headcount: 2 }] }));
    world.seedDefaults({ collectivePath: cfg, townJsonPath: cfg });
    const m = world.agents.require(world.buildings.require("lab").managerAgentId!);
    expect(m).toMatchObject({ kind: "resident", homeBuildingId: "lab", forkOf: null });
    expect(world.agents.count()).toBe(2); // the Planner and this manager
  });
});
