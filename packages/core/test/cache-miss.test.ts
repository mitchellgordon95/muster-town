import { describe, expect, it } from "vitest";
import { CACHE_MISS_SHARE, cacheMissCheck, checkCacheMiss, firstTurnUsage, utcDay, World } from "../src/index.ts";

const M = "claude-opus-5-5"; // list price: output $20/MTok, 1 h cache write $8/MTok
/** a session whose cost is `w1hUsd` of 1 h cache writes and `outUsd` of output */
const sess = (id: string, purpose: "manage" | "work", w1hUsd: number, outUsd: number) =>
  ({ id, purpose, model: M, byModel: null, input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: (w1hUsd / 8) * 1e6, output: (outUsd / 20) * 1e6 });
const none = () => undefined;
const usageLine = (read: number, write: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", ...extra, message: { usage: { input_tokens: 3, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write } } });

describe("cache-miss check (gr_lwgus14rd2 step 2, kr_f49co6lg51)", () => {
  it("alerts above 20% of the purpose's cost in 1 h cache writes, not at 19%", () => {
    expect(CACHE_MISS_SHARE).toBe(0.2);
    expect(cacheMissCheck([sess("se_a", "manage", 19, 81)], none, "2026-11-04")).toEqual([]);
    const [a] = cacheMissCheck([sess("se_a", "manage", 21, 79)], none, "2026-11-04");
    expect(a).toMatchObject({ purpose: "manage", model: M, share: 0.21, usd: 100, sessions: 1, reasons: ["share"], sessionIds: ["se_a"], firstTurn: [] });
  });

  it("one alert per purpose (the costliest crossing model); purposes are apart; alerted purposes are skipped", () => {
    const other = { ...sess("se_c", "manage", 50, 50), model: "claude-fable-5-1" };
    const out = cacheMissCheck([sess("se_a", "manage", 30, 70), sess("se_b", "work", 30, 70), other], none, "d");
    expect(out.map((a) => [a.purpose, a.model])).toEqual([["manage", "claude-fable-5-1"], ["work", M]]);
    expect(cacheMissCheck([sess("se_a", "manage", 30, 70)], none, "d", new Set(["manage"]))).toEqual([]);
  });

  it("first-turn rule: a first turn that wrote more to the cache than it read alerts even under the share", () => {
    const first = (id: string) => (id === "se_cold" ? { cacheRead: 2_000, cacheWrite: 30_000 } : { cacheRead: 30_000, cacheWrite: 7_000 });
    expect(cacheMissCheck([sess("se_warm", "manage", 1, 99)], first, "d")).toEqual([]);
    const [a] = cacheMissCheck([sess("se_warm", "manage", 10, 90), sess("se_cold", "manage", 1, 99)], first, "d");
    expect(a.reasons).toEqual(["first-turn"]);
    expect(a.sessionIds).toEqual(["se_cold", "se_warm"]); // offenders first
    expect(a.firstTurn).toEqual([{ sessionId: "se_cold", cacheRead: 2_000, cacheWrite: 30_000 }]);
  });

  it("reads the first main-thread assistant usage from SDK JSONL (sidechains and junk skipped)", () => {
    const jsonl = [JSON.stringify({ type: "user", message: { content: "hi" } }), "not json \"assistant\"", usageLine(5, 99, { isSidechain: true }), usageLine(20_000, 6_000), usageLine(1, 2)].join("\n");
    expect(firstTurnUsage(jsonl)).toEqual({ cacheRead: 20_000, cacheWrite: 6_000 });
    expect(firstTurnUsage(JSON.stringify({ type: "user" }))).toBeNull();
  });

  it("on a world: one `system` event per purpose per day with the session ids, first turns read from the stored transcript", () => {
    const world = World.open(":memory:");
    world.seedDefaults({ adminName: "T", importDir: new URL("../../../buildings/carbon-cycle", import.meta.url).pathname });
    const noor = world.agents.first("name = ?", ["Noor"])!;
    const end = (purpose: "manage" | "work", w1h: number, out: number) => {
      const s = world.ops.startSession(noor.id, { purpose, model: M });
      return world.ops.endSession(s.id, { status: "done", counts: { input: 0, output: out, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: w1h } });
    };
    const now = new Date();
    const quiet = end("work", 1_000, 1_000_000); // $0.008 of $20.008: under the share
    expect(checkCacheMiss(world, now)).toEqual([]);
    world.transcripts.put(quiet, Buffer.from([JSON.stringify({ type: "user" }), usageLine(100, 40_000)].join("\n")), { compressed: false, source: "host" });
    const loud = end("manage", 4_000_000, 1_000_000); // $32 of $52
    const fired = checkCacheMiss(world, now);
    expect(fired.map((a) => [a.purpose, a.reasons])).toEqual([["manage", ["share"]], ["work", ["first-turn"]]]);
    expect(checkCacheMiss(world, now)).toEqual([]); // once per purpose per day
    const evs = world.events.list({ types: ["system"], textLike: "Cache miss:%" });
    expect(evs).toHaveLength(2);
    const m = evs.find((e) => e.payload.purpose === "manage")!;
    expect(m.payload).toMatchObject({ alert: "cache-miss", day: utcDay(now), model: M, share: 0.6154, sessionIds: [loud.id] });
    expect(m.text).toBe(`Cache miss: manage sessions on ${M}: 1 h cache writes were 62% of today's cost (alert above 20%); 1 session: ${loud.id}`);
    expect(evs.find((e) => e.payload.purpose === "work")!.text).toContain(`1 first turn wrote more to the cache than it read; 1 session: ${quiet.id}`);
    world.close();
  });
});
