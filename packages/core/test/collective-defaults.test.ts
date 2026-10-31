import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CreateBuildingInput, UpdateBuildingInput } from "@muster-town/schema";
import { createBuilding } from "../src/index.ts";
import { freshWorld, seededWorld } from "./helpers.ts";

/** 1:1 mt_n25udpflus decision 3: model, cheap model, max turns, daily budget and code access are collective defaults, not building settings. */
describe("collective defaults", () => {
  it("the building API takes none of the five fields", () => {
    const fields = { model: "m", cheapModel: "c", maxTurnsPerSession: 5, dailyTokensPerAgent: 5, codeAccess: true };
    expect(CreateBuildingInput.parse(fields)).toEqual({});
    expect(UpdateBuildingInput.parse(fields)).toEqual({});
  });

  it("saving them writes through to every lab, leaves the Town Hall alone, and a new building copies them", () => {
    const { world, admin } = seededWorld();
    const hall = world.buildings.first("kind = 'town-hall'")!;
    const { defaults, buildings } = world.setTownDefaults({ model: "claude-sonnet-5-5", dailyTokensPerAgent: 2_000_000 }, admin.id);
    expect(defaults).toMatchObject({ model: "claude-sonnet-5-5", dailyTokensPerAgent: 2_000_000, cheapModel: "claude-haiku-5-5" });
    expect(world.town.get().defaults).toEqual(defaults);
    expect(buildings.length).toBeGreaterThan(0);
    for (const b of world.buildings.all().filter((x) => x.kind === "lab")) expect(b).toMatchObject({ model: "claude-sonnet-5-5", dailyTokensPerAgent: 2_000_000 });
    expect(world.buildings.require(hall.id)).toEqual(hall);
    expect(world.events.list({ types: ["system"] }).some((e) => e.payload.townDefaults)).toBe(true);

    world.setTownDefaults({ maxTurnsPerSession: 120 }); // the earlier keys stay
    const b = world.ops.createBuilding(admin, { name: "Fresh" });
    expect(b).toMatchObject({ model: "claude-sonnet-5-5", dailyTokensPerAgent: 2_000_000, maxTurnsPerSession: 120 });
    // a PATCH can't diverge it again
    expect(world.ops.updateBuilding(admin, b.id, { model: "x" } as never).model).toBe("claude-sonnet-5-5");
  });

  it("seed: collective.json `defaults` go into every building; an old spec's per-building value still wins", () => {
    const { world, dir } = freshWorld();
    const cfg = join(dir, "collective.json");
    writeFileSync(cfg, JSON.stringify({
      name: "T", goal: "", defaults: { maxTurnsPerSession: 120, dailyTokensPerAgent: 1_000_000 },
      buildings: [{ id: "a", name: "A" }, { id: "old", name: "Old", maxTurnsPerSession: 40 }],
    }));
    world.seedDefaults({ collectivePath: cfg });
    expect(world.town.defaults()).toMatchObject({ maxTurnsPerSession: 120, dailyTokensPerAgent: 1_000_000, model: "claude-opus-5-5", codeAccess: false });
    expect(world.buildings.require("a")).toMatchObject({ maxTurnsPerSession: 120, dailyTokensPerAgent: 1_000_000 });
    expect(world.buildings.require("old").maxTurnsPerSession).toBe(40);
    expect(createBuilding(world, { name: "Later" }, null).maxTurnsPerSession).toBe(120);
  });

  it("a town from before the defaults takes its oldest lab's values on boot, without changing any building", () => {
    const { world, seed } = seededWorld();
    const lab = world.buildings.require(seed.lab!.id);
    world.buildings.upsert({ ...lab, dailyTokensPerAgent: 1_666_667, maxTurnsPerSession: 120 });
    const other = createBuilding(world, { name: "Other", dailyTokensPerAgent: 350_000 }, null);
    const { defaults: _gone, ...town } = world.town.get();
    world.db.prepare("UPDATE meta SET value = ? WHERE key = 'town'").run(JSON.stringify(town));
    expect(world.town.hasDefaults()).toBe(false);
    world.seedDefaults({});
    expect(world.town.defaults()).toMatchObject({ dailyTokensPerAgent: 1_666_667, maxTurnsPerSession: 120 });
    expect(world.buildings.require(other.id).dailyTokensPerAgent).toBe(350_000);
  });
});
