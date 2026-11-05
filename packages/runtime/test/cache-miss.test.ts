import { describe, expect, it } from "vitest";
import { World } from "@muster-town/core";
import { cacheMissDue } from "../src/cache-miss.ts";

const usageLine = (i: number, read: number, write: number) =>
  JSON.stringify({ type: "assistant", message: { id: `msg_${i}`, usage: { input_tokens: 3, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write } } });

describe("cacheMissDue (the tick re-checks the day only after a session ended; once per purpose per day)", () => {
  it("quiet with no ended session, fires once when one ends busting its prefix, stays quiet on later ticks", () => {
    const world = World.open(":memory:");
    world.seedDefaults({ adminName: "T", importDir: new URL("../../../buildings/carbon-cycle", import.meta.url).pathname });
    const noor = world.agents.first("name = ?", ["Noor"])!;
    const endBusting = () => {
      const s = world.ops.startSession(noor.id, { purpose: "manage", model: "claude-opus-5-5" });
      const ended = world.ops.endSession(s.id, { status: "done", counts: { input: 0, output: 1_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 90_000 } });
      world.transcripts.put(ended, Buffer.from([usageLine(0, 0, 30_000), usageLine(1, 2_000, 30_000), usageLine(2, 2_000, 30_000)].join("\n")), { compressed: false, source: "host" });
    };
    expect(cacheMissDue(world, new Date())).toBe(0);
    endBusting();
    expect(cacheMissDue(world, new Date(Date.now() + 1000))).toBe(1);
    expect(cacheMissDue(world, new Date(Date.now() + 2000))).toBe(0);
    endBusting();
    expect(cacheMissDue(world, new Date(Date.now() + 3000))).toBe(0);
    expect(world.events.list({ types: ["system"], textLike: "Cache miss:%" })).toHaveLength(1);
    world.close();
  });
});
