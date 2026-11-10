import { describe, expect, it } from "vitest";
import { BUST_TURN_RATE, CACHE_MISS_SHARE, cacheMissCheck, checkCacheMiss, MIN_SESSIONS, MIN_TURNS, sessionBust, turnUsage, utcDay, World } from "../src/index.ts";

const M = "claude-opus-5-5";
const sess = (id: string, purpose: "manage" | "work") => ({ id, purpose });
const usageLine = (read: number, write: number, extra: Record<string, unknown> = {}, id?: string) =>
  JSON.stringify({ type: "assistant", ...extra, message: { ...(id ? { id } : {}), usage: { input_tokens: 3, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write } } });
/** a healthy session: a cold first turn, then turns reading the prefix and writing only the new turn */
const warm = [{ cacheRead: 0, cacheWrite: 30_000 }, { cacheRead: 30_000, cacheWrite: 2_000 }, { cacheRead: 32_000, cacheWrite: 3_000 }, { cacheRead: 35_000, cacheWrite: 7_000 }];
/** a busting session: the prefix is re-written on every turn */
const busting = [{ cacheRead: 0, cacheWrite: 30_000 }, { cacheRead: 2_000, cacheWrite: 30_000 }, { cacheRead: 2_000, cacheWrite: 31_000 }, { cacheRead: 2_000, cacheWrite: 32_000 }];

describe("cache-miss check (gr_lwgus14rd2 step 2, kr_f49co6lg51: sessions that bust their prompt prefix)", () => {
  it("a session busts when more than half of its turns 2+ re-write at least half of their prefix; turn 1 never counts", () => {
    expect(BUST_TURN_RATE).toBe(0.5);
    expect(MIN_TURNS).toBe(2);
    expect(sessionBust(warm)).toEqual({ turns: 3, bustTurns: 0, rewritten: 0, busts: false });
    expect(sessionBust(busting)).toEqual({ turns: 3, bustTurns: 3, rewritten: 93_000, busts: true });
    // one compaction turn in a long session is not a bust; two of three is
    expect(sessionBust([...warm, { cacheRead: 0, cacheWrite: 50_000 }]).busts).toBe(false);
    expect(sessionBust([warm[0], busting[1], busting[2], warm[1]])).toMatchObject({ turns: 3, bustTurns: 2, busts: true });
    // too few turns after the first: no signal (even a cold start that wrote everything)
    expect(sessionBust([{ cacheRead: 0, cacheWrite: 30_000 }, { cacheRead: 0, cacheWrite: 30_000 }]).busts).toBe(false);
    expect(sessionBust([]).turns).toBe(0);
  });

  it("alerts when busting sessions pass 10% of the purpose's sessions with a signal, not at 10%, and never under 5 sessions", () => {
    expect(CACHE_MISS_SHARE).toBe(0.1);
    expect(MIN_SESSIONS).toBe(5);
    const turns = (id: string) => (id.startsWith("se_bust") ? busting : id === "se_short" ? [warm[0]] : warm);
    const nine = Array.from({ length: 9 }, (_, i) => sess(`se_w${i}`, "manage"));
    expect(cacheMissCheck([...nine, sess("se_bust", "manage"), sess("se_short", "manage")], turns, "2026-11-05")).toEqual([]); // 1 of 10 = 10%
    const [a] = cacheMissCheck([...nine.slice(1), sess("se_bust", "manage"), sess("se_short", "manage")], turns, "2026-11-05");
    expect(a).toEqual({ day: "2026-11-05", purpose: "manage", share: 0.1111, sessions: 9, busting: 1, noSignal: 1, sessionIds: ["se_bust"], worst: [{ sessionId: "se_bust", turns: 3, bustTurns: 3, rewritten: 93_000 }] });
    // the day's first sessions are no verdict: 1 of 1 (100%) and 1 of 4 stay quiet, 1 of 5 fires (a short session is not one of the 5)
    expect(cacheMissCheck([sess("se_bust", "manage")], turns, "d")).toEqual([]);
    expect(cacheMissCheck([...nine.slice(0, 3), sess("se_bust", "manage"), sess("se_short", "manage")], turns, "d")).toEqual([]);
    expect(cacheMissCheck([...nine.slice(0, 4), sess("se_bust", "manage")], turns, "d").map((a) => [a.sessions, a.share])).toEqual([[5, 0.2]]);
  });

  it("one alert per purpose, worst sessions first (share of busting turns, then tokens re-written); alerted purposes are skipped; no transcript = no signal", () => {
    const known: Record<string, { cacheRead: number; cacheWrite: number }[] | null> = { se_a: [warm[0], busting[1], busting[2], warm[1]], se_b: busting, se_c: [warm[0], busting[1], warm[1], busting[2], warm[2]], se_none: null };
    const turns = (id: string) => (id in known ? known[id] : warm);
    const out = cacheMissCheck([sess("se_a", "manage"), sess("se_b", "manage"), sess("se_c", "manage"), sess("se_d", "manage"), sess("se_e", "manage"), sess("se_none", "manage"), sess("se_w", "work")], turns, "d");
    expect(out.map((a) => [a.purpose, a.sessions, a.sessionIds, a.noSignal])).toEqual([["manage", 5, ["se_b", "se_a"], 1]]); // se_c: 2 of 4 is not "most"
    expect(cacheMissCheck([sess("se_b", "manage")], turns, "d", new Set(["manage"]))).toEqual([]);
  });

  it("reads one turn per message id from SDK JSONL (blocks repeat a call's usage; sidechains and junk skipped)", () => {
    const jsonl = [JSON.stringify({ type: "user", message: { content: "hi" } }), "not json \"assistant\"", usageLine(5, 99, { isSidechain: true }), usageLine(0, 20_000, {}, "msg_1"), usageLine(0, 20_000, {}, "msg_1"), usageLine(20_000, 1_000, {}, "msg_2"), usageLine(1, 2)].join("\n");
    expect(turnUsage(jsonl)).toEqual([{ cacheRead: 0, cacheWrite: 20_000 }, { cacheRead: 20_000, cacheWrite: 1_000 }, { cacheRead: 1, cacheWrite: 2 }]);
    expect(turnUsage(JSON.stringify({ type: "user" }))).toEqual([]);
  });

  it("on a world: one `system` event per purpose per day naming the worst sessions, turns read from the stored transcript", () => {
    const world = World.open(":memory:");
    world.seedDefaults({ adminName: "T", importDir: new URL("../../../buildings/carbon-cycle", import.meta.url).pathname });
    const noor = world.agents.first("name = ?", ["Noor"])!;
    const end = (purpose: "manage" | "work", turns: { cacheRead: number; cacheWrite: number }[]) => {
      const s = world.ops.startSession(noor.id, { purpose, model: M });
      const ended = world.ops.endSession(s.id, { status: "done", counts: { input: 0, output: 1_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 1_000 } });
      world.transcripts.put(ended, Buffer.from([JSON.stringify({ type: "user" }), ...turns.map((t, i) => usageLine(t.cacheRead, t.cacheWrite, {}, `msg_${i}`))].join("\n")), { compressed: false, source: "host" });
      return ended;
    };
    const now = new Date();
    end("work", warm);
    const loud = end("manage", busting);
    expect(checkCacheMiss(world, now)).toEqual([]); // the day's first manage session alone is no verdict
    for (let i = 0; i < 4; i++) end("manage", warm);
    const fired = checkCacheMiss(world, now);
    expect(fired.map((a) => [a.purpose, a.share, a.sessionIds])).toEqual([["manage", 0.2, [loud.id]]]);
    expect(checkCacheMiss(world, now)).toEqual([]); // once per purpose per day
    const evs = world.events.list({ types: ["system"], textLike: "Cache miss:%" });
    expect(evs).toHaveLength(1);
    expect(evs[0].payload).toMatchObject({ alert: "cache-miss", day: utcDay(now), purpose: "manage", sessions: 5, busting: 1, noSignal: 0, sessionIds: [loud.id] });
    expect(evs[0].text).toBe(`Cache miss: 1 of 5 manage sessions (20%, alert above 10%) re-wrote their prompt prefix on most turns (a turn writing ≥ 50% of its context fresh); worst: ${loud.id} (3 of 3 turns)`);
    world.close();
  });
});
