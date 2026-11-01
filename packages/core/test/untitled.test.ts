import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBuilding, createResident } from "../src/index.ts";
import { freshWorld, REPO_ROOT, seededWorld } from "./helpers.ts";

describe("residents have no title or job description", () => {
  it("createResident needs only a building and a name", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Lab" }, seed.admin.id);
    const a = createResident(world, { buildingId: b.id, name: "Ada" });
    expect(a).toMatchObject({ name: "Ada", title: "", direction: "" });
    expect(world.events.recent({ agentId: a.id }).some((e) => e.text === `Ada joined Lab`)).toBe(true);
  });
  it("the workshop collective seeds its residents without titles or directions", () => {
    const { world } = freshWorld();
    world.seedDefaults({ collectivePath: join(REPO_ROOT, "collectives/workshop/collective.json") });
    const residents = world.agents.where("kind = 'resident'", []).filter((a) => a.name === "Pix");
    expect(residents).toHaveLength(1);
    for (const a of residents) expect([a.title, a.direction]).toEqual(["", ""]);
  });
});
