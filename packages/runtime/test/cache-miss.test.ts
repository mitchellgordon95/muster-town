import { describe, expect, it } from "vitest";
import { World } from "@muster-town/core";
import { cacheMissDue } from "../src/cache-miss.ts";

describe("cacheMissDue (the tick re-checks the day only after a session ended; once per purpose per day)", () => {
  it("quiet with no ended session, fires once when one ends over the share, stays quiet on later ticks", () => {
    const world = World.open(":memory:");
    world.seedDefaults({ adminName: "T", importDir: new URL("../../../buildings/carbon-cycle", import.meta.url).pathname });
    const noor = world.agents.first("name = ?", ["Noor"])!;
    expect(cacheMissDue(world, new Date())).toBe(0);
    const s = world.ops.startSession(noor.id, { purpose: "manage", model: "claude-opus-5-5" });
    world.ops.endSession(s.id, { status: "done", counts: { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 4_000_000 } });
    expect(cacheMissDue(world, new Date(Date.now() + 1000))).toBe(1);
    expect(cacheMissDue(world, new Date(Date.now() + 2000))).toBe(0);
    const s2 = world.ops.startSession(noor.id, { purpose: "manage", model: "claude-opus-5-5" });
    world.ops.endSession(s2.id, { status: "done", counts: { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 4_000_000 } });
    expect(cacheMissDue(world, new Date(Date.now() + 3000))).toBe(0);
    expect(world.events.list({ types: ["system"], textLike: "Cache miss:%" })).toHaveLength(1);
    world.close();
  });
});
