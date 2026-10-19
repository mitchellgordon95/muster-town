import { describe, it, expect } from "vitest";
import { World } from "../src/index.ts";

describe("source cards publish to the library", () => {
  it("a member's published source lands in state library; notes stay on the board", async () => {
    const world = World.open(":memory:");
    world.seedDefaults({ adminName: "T", importDir: new URL("../../../buildings/carbon-cycle", import.meta.url).pathname });
    const noor = world.agents.first("name = ?", ["Noor"])!;
    const src = await world.verbs.write(noor, { type: "source", title: "NOAA GML trends", body: "- URL: https://gml.noaa.gov", state: "building" });
    expect(world.docs.get(src.id)!.state).toBe("library");
    const note = await world.verbs.write(noor, { type: "note", title: "scratch", body: "x", state: "building" });
    expect(world.docs.get(note.id)!.state).toBe("building");
    world.close();
  });
});
