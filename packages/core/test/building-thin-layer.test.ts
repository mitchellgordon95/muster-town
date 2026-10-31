import { describe, expect, it } from "vitest";
import { CreateBuildingInput } from "@muster-town/schema";
import { sessionMemory, workSystemPrompt } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

/** 1:1 mt_n25udpflus decision 3: a building is a thin layer on the goal tree (its goal, desks, an optional name, its manager). */
describe("building settings are a thin layer on goals", () => {
  it("the API takes no goal or description text; the attached goal is the building's purpose everywhere it is read", async () => {
    const { world, admin, by } = seededWorld();
    expect(CreateBuildingInput.parse({ name: "X", goal: "old", description: "d" })).not.toHaveProperty("goal");
    const goal = world.goalTree.create(admin, { parentId: "gl_trust", text: "A funder sees what every token bought" });
    world.ops.updateBuilding(admin, LAB, { goalId: goal.id });
    const b = world.buildings.require(LAB);
    expect(b.goal).not.toBe(goal.text); // the stored text stays as it was; nothing reads it
    expect(world.goalTree.purposeOf(b)).toBe(goal.text);
    const mei = by("Mei");
    expect(workSystemPrompt(mei, b, world.town.get(), sessionMemory(world, mei, b))).toContain(`Building goal: ${goal.text}`);
    expect((await world.verbs.look(mei, {})).building?.goal).toBe(goal.text);
  });

  it("a blank name is the goal's short text, at creation and on every save left blank; a typed name stays", () => {
    const { world, admin } = seededWorld();
    const long = world.goalTree.create(admin, { parentId: "gl_join", text: "A stranger who arrives can finish useful work in their first session" });
    const short = world.goalTree.create(admin, { parentId: "gl_fund", text: "Funders see spend" });
    const b = world.ops.createBuilding(admin, { goalId: long.id });
    expect(b.name).toBe("A stranger who arrives can finish…");
    expect(b.name.length).toBeLessThanOrEqual(40);
    expect(b.managerAgentId).toBeTruthy(); // a building made from the UI/API gets its manager
    expect(world.ops.updateBuilding(admin, b.id, { name: "Arrivals" }).name).toBe("Arrivals");
    expect(world.ops.updateBuilding(admin, b.id, { goalId: short.id }).name).toBe("Arrivals"); // a typed name stays
    expect(world.ops.updateBuilding(admin, b.id, { name: "  " }).name).toBe("Funders see spend"); // blank: the current attachment
    expect(world.ops.updateBuilding(admin, b.id, { name: "", goalId: long.id }).name).toBe("A stranger who arrives can finish…");
  });
});
