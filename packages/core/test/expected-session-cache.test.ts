import { describe, expect, it, vi } from "vitest";
import type { Session } from "@muster-town/schema";
import { EXPECTED_SESSION_DEFAULT, percentile, sessionTokens } from "../src/bank.ts";
import { createBuilding, createResident, freeTokensAll, type World } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const DAY = 86_400_000;
/** bank.ts EXPECTED_SESSION_MIN_SAMPLE */
const EXPECTED_SESSION_MIN_SAMPLE = 5;
const NOW = new Date("2026-11-04T12:00:00.000Z");

/** The row-loading computation `Bank.expectedSession` had before its cache (gr_db6ofyd0yf step 1): the oracle. */
function oracle(world: World, buildingId: string | null, now: Date): { tokens: number; sample: number } {
  const since = new Date(now.getTime() - 7 * DAY).toISOString();
  const ended = world.sessions.where("purpose = 'work' AND endedAt IS NOT NULL AND endedAt > ?", [since]);
  const sizes = (rows: Session[]) => rows.map((s) => sessionTokens(s)).filter((t) => t > 0);
  if (buildingId) {
    const homes = new Set(world.agents.where("homeBuildingId = ? OR buildingId = ?", [buildingId, buildingId]).map((a) => a.id));
    const own = sizes(ended.filter((s) => homes.has(s.agentId)));
    if (own.length >= EXPECTED_SESSION_MIN_SAMPLE) return { tokens: percentile(own, 0.9), sample: own.length };
  }
  const all = sizes(ended);
  return all.length >= EXPECTED_SESSION_MIN_SAMPLE ? { tokens: percentile(all, 0.9), sample: all.length } : { tokens: EXPECTED_SESSION_DEFAULT, sample: 0 };
}

/** A lab agent and a second building's agent, and a helper that ends a work session with given counters. */
function setup() {
  const s = seededWorld();
  const { world, admin } = s;
  const lab = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  const other = createBuilding(world, { name: "Other" }, admin.ownerUserId ?? null);
  const otherAgent = createResident(world, { buildingId: other.id, name: "O", title: "t", direction: "d" });
  const end = (agentId: string, endedAt: Date, usage: Partial<Session>, purpose: Session["purpose"] = "work") => {
    const r = world.ops.startSession(agentId, { purpose, model: usage.model ?? "claude-opus-5-5" });
    return world.sessions.patch(r.id, { ...usage, status: "done", endedAt: endedAt.toISOString() });
  };
  return { ...s, lab, other, otherAgent, end };
}

/** Varied history: models, a per-model breakdown, an old pre-076 row (no bankModel), zero-token rows, out-of-window and non-work rows. */
function seedHistory(x: ReturnType<typeof setup>) {
  const { lab, otherAgent, end } = x;
  const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
  for (let i = 0; i < 9; i++) end(lab.id, ago(i + 1), { output: 5_000 * (i + 1), input: 1_000 * i, cacheRead: 200_000 * i, cacheWrite5m: 300 * i });
  end(lab.id, ago(20), { model: "claude-fable-5-1", output: 12_345, cacheRead: 900_000, byModel: { "claude-fable-5-1": { input: 10, output: 12_000, cacheRead: 900_000, cacheWrite5m: 0, cacheWrite1h: 0 }, "claude-haiku-5-5": { input: 50, output: 345, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 7 } } });
  end(lab.id, ago(30), { model: "claude-sonnet-5-5", bankModel: null, output: 40_000, cacheWrite1h: 5_000 });
  end(lab.id, ago(2), {});
  end(lab.id, ago(8 * 24), { output: 9_999_999 });
  end(lab.id, ago(3), { output: 7_777_777 }, "manage");
  for (let i = 0; i < 3; i++) end(otherAgent.id, ago(i + 4), { output: 300_000 + i });
}

describe("Bank.expectedSession cache (gr_db6ofyd0yf step 1)", () => {
  it("gives exactly what the row-loading computation gives, for a building, a thin building and the town", () => {
    const x = setup();
    const { world, other } = x;
    seedHistory(x);
    for (const b of [LAB, other.id, null]) expect(world.bank.expectedSession(b, NOW)).toEqual(oracle(world, b, NOW));
    expect(world.bank.expectedSession(LAB, NOW).sample).toBe(11);
    // the thin building falls back to the town's figure
    expect(world.bank.expectedSession(other.id, NOW)).toEqual(world.bank.expectedSession(null, NOW));
    // a week later the window is empty: the default, as before
    const later = new Date(NOW.getTime() + 9 * DAY);
    for (const b of [LAB, null]) expect(world.bank.expectedSession(b, later)).toEqual(oracle(world, b, later));
    expect(world.bank.expectedSession(null, later)).toEqual({ tokens: EXPECTED_SESSION_DEFAULT, sample: 0 });
  });

  it("prices each row as sessionTokens does: a per-model breakdown, a pre-076 row in its own model, cache writes", () => {
    const rows: Partial<Session>[] = [
      { model: "claude-fable-5-1", output: 12_000, cacheRead: 900_000, byModel: { "claude-fable-5-1": { input: 10, output: 12_000, cacheRead: 900_000, cacheWrite5m: 0, cacheWrite1h: 0 }, "claude-haiku-5-5": { input: 50, output: 345, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 7 } } },
      { model: "claude-sonnet-5-5", bankModel: null, output: 40_000, cacheWrite1h: 5_000 },
      { model: "claude-opus-5-5", input: 3_000, output: 20_000, cacheRead: 400_000, cacheWrite5m: 9_000, cacheWrite1h: 1_000 },
    ];
    for (const usage of rows) {
      const x = setup();
      const ended = Array.from({ length: 5 }, (_, i) => x.end(x.lab.id, new Date(NOW.getTime() - (i + 1) * 60_000), usage));
      expect(x.world.bank.expectedSession(LAB, NOW)).toEqual({ tokens: sessionTokens(ended[0]!), sample: 5 });
      expect(x.world.bank.expectedSession(null, NOW)).toEqual(oracle(x.world, null, NOW));
    }
  });

  it("a session ending shows in the next call, without waiting for the cache to expire", () => {
    const x = setup();
    const { world, lab, end } = x;
    seedHistory(x);
    const before = world.bank.expectedSession(LAB, NOW);
    end(lab.id, new Date(NOW.getTime() - 1000), { output: 5_000_000 });
    const after = world.bank.expectedSession(LAB, NOW);
    expect(after).toEqual(oracle(world, LAB, NOW));
    expect(after).not.toEqual(before);
    // usage settling on an already ended session changes the figure too
    const s = end(lab.id, new Date(NOW.getTime() - 500), { output: 1 });
    world.bank.expectedSession(null, NOW);
    world.sessions.patch(s.id, { output: 9_000_000 });
    expect(world.bank.expectedSession(null, NOW)).toEqual(oracle(world, null, NOW));
  });

  it("with nothing ended it reads one aggregate row, not the window, even a minute later", () => {
    const x = setup();
    const { world } = x;
    seedHistory(x);
    const spy = vi.spyOn(world.sessions, "columns");
    const first = world.bank.expectedSession(LAB, NOW);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockClear();
    const later = new Date(NOW.getTime() + 60_000);
    expect(world.bank.expectedSession(LAB, later)).toEqual(first);
    expect(world.bank.expectedSession(null, later)).toEqual(oracle(world, null, later));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.every((c) => c[0].some((col) => col.startsWith("COUNT(")))).toBe(true);
  });

  it("a session leaving the 7-day window, or an agent moving building, shows in the next call", () => {
    const x = setup();
    const { world, lab, other, otherAgent } = x;
    seedHistory(x);
    // the oldest in-window lab session (30 h old) leaves the window 30 h before the 8-day-old one would have entered
    const edge = new Date(NOW.getTime() + 7 * DAY - 25 * 3_600_000);
    for (const b of [LAB, null]) expect(world.bank.expectedSession(b, edge)).toEqual(oracle(world, b, edge));
    // the other building's three sessions join the lab's figure once their agent lives there
    const before = world.bank.expectedSession(LAB, NOW);
    world.agents.patch(otherAgent.id, { homeBuildingId: LAB, buildingId: LAB });
    expect(world.bank.expectedSession(LAB, NOW)).toEqual(oracle(world, LAB, NOW));
    expect(world.bank.expectedSession(LAB, NOW)).not.toEqual(before);
    expect(world.bank.expectedSession(other.id, NOW)).toEqual(oracle(world, other.id, NOW));
    expect(lab.homeBuildingId).toBe(LAB);
  });

  it("Bank.available and freeTokensAll give the same figures with the cache cold and warm", () => {
    const x = setup();
    const { world } = x;
    seedHistory(x);
    const snap = () => ({ available: world.bank.available(LAB, NOW), balance: world.bank.balance(NOW), free: [...freeTokensAll(world, NOW).entries()] });
    const cold = snap();
    world.bank.expectedSession(LAB, NOW);
    world.streams.list(NOW);
    expect(snap()).toEqual(cold);
  });
});
