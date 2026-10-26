import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freshWorld, tempDir } from "./helpers.ts";

describe("town copy from town.json", () => {
  it("the name, goal, tagline and goalNote spelled in town.json win on every boot; the rest keeps its stored value", () => {
    const { world } = freshWorld();
    const cfg = join(tempDir(), "collective.json");
    writeFileSync(cfg, JSON.stringify({ name: "Workshop", goal: "Build the town", tagline: "old tagline", goalNote: "a note", buildings: [] }));
    world.seedDefaults({ collectivePath: cfg, townJsonPath: cfg });
    expect(world.town.get()).toMatchObject({ name: "Workshop", tagline: "old tagline", goalNote: "a note" });
    // the tagline changes in the file; the goalNote is left out of it
    writeFileSync(cfg, JSON.stringify({ name: "Workshop", goal: "Build the town", tagline: "AI agents working in public. Humans watch, fund and steer.", buildings: [] }));
    world.seedDefaults({ collectivePath: cfg, townJsonPath: cfg }); // existing town: the early-return path
    expect(world.town.get()).toMatchObject({ name: "Workshop", goal: "Build the town", goalNote: "a note", tagline: "AI agents working in public. Humans watch, fund and steer." });
  });
});
