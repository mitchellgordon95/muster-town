import { describe, expect, it } from "vitest";
import { buildingRoleId, sessionMemory, workSystemPrompt, TOWN_HALL_ID } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

// presence (1:1 mt_3jtclcoxl2): an agent finds every building and its manager from the tools, not by searching docs
describe("town directory", () => {
  function setup() {
    const s = seededWorld();
    const mei = s.by("Mei");
    const manager = s.world.agents.first("homeBuildingId = ? AND kind != 'human' AND id != ?", [LAB, mei.id])!;
    s.world.buildings.upsert({ ...s.world.buildings.require(LAB, "building"), managerAgentId: manager.id });
    s.world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
    return { ...s, mei, manager };
  }

  it("`town` lists every building with its id, manager, goal and who is in it now; query filters", async () => {
    const { world, mei, manager } = setup();
    const planner = world.reorgs.ensurePlanner();
    const res = await world.verbs.town(mei, {});
    expect(res.buildings.map((b) => b.id)).toEqual(world.buildings.all().map((b) => b.id).sort((a, b) => Number(b === TOWN_HALL_ID) - Number(a === TOWN_HALL_ID)));
    expect(res.buildings[0]).toMatchObject({ id: TOWN_HALL_ID, manager: { id: planner.id, name: "Planner" } });
    const lab = res.buildings.find((b) => b.id === LAB)!;
    expect(lab.manager).toMatchObject({ id: manager.id, name: manager.name });
    expect(lab.goal).toBe(world.goalTree.purposeOf(world.buildings.require(LAB, "building")).replace(/\s+/g, " ").trim().slice(0, 160));
    expect(lab.here.map((a) => a.id)).toContain(mei.id);
    expect(lab.liveForks).toBe(0);
    expect((await world.verbs.town(mei, { query: manager.name.toUpperCase() })).buildings.map((b) => b.id)).toEqual([LAB]);
    expect((await world.verbs.town(mei, { query: "no such building" })).buildings).toEqual([]);
  });

  it("`look` points at `town`; the brief names every other building's manager; `tell` a building id reaches its manager", async () => {
    const { world, mei, manager } = setup();
    expect((await world.verbs.look(mei, {})).town).toBe(`${world.buildings.count()} buildings in town: \`town\` lists them with their managers and who is in each now.`);
    const th = world.buildings.require(TOWN_HALL_ID, "building");
    const b = world.buildings.require(LAB, "building");
    const prompt = workSystemPrompt(mei, th, world.town.get(), sessionMemory(world, mei, th));
    expect(prompt).toContain(`Other buildings (building → manager;`);
    expect(prompt).toContain(`${b.name} (${LAB}) → ${manager.name} (${manager.id})`);
    const sent = await world.verbs.tell(mei, { to: LAB, text: "hello manager" });
    expect(sent.to).toBe(manager.id);
    expect(world.messages.first("toId = ? AND kind = 'tell'", [manager.id])?.body).toBe("hello manager");
    await expect(world.verbs.tell(mei, { to: "bl_nope", text: "x" })).rejects.toThrow(/No agent or building/);
  });
});
