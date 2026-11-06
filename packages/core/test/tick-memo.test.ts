import { describe, expect, it } from "vitest";
import { ROOT_GOAL_ID } from "@muster-town/schema";
import { createBuilding, createResident, freeTokensAll, tickMemo, withTickMemo } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

// gr_db6ofyd0yf step 3: one scheduler pass computes freeTokensAll and Bank.available once, not per queued assignment,
// and every answer is the one a fresh computation gives (any write starts the memo over).
const T0 = new Date("2026-11-04T12:00:00.000Z");

function town() {
  const { world, seed } = seededWorld();
  const b = createBuilding(world, { name: "Banked" }, seed.admin.id);
  const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
  world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: "m", tokens: 1000, apiKey: "sk" }, T0);
  world.bank.addInput(seed.admin.id, { label: "Earmark", source: "api-key", model: "m", tokens: 300, apiKey: "sk-e", goalId: ROOT_GOAL_ID } as never, T0);
  return { world, b, a, admin: seed.admin.id };
}

describe("tick memo (scheduler pass)", () => {
  it("computes once per scope, never outside one, and starts over after any write", () => {
    const { world } = town();
    let n = 0;
    const owner = {};
    const f = () => tickMemo(owner, "k", T0, () => ++n);
    expect([f(), f()]).toEqual([1, 2]);
    withTickMemo(world.db, () => {
      expect([f(), f()]).toEqual([3, 3]);
      // a `now` more than a second away is not the same question
      expect(tickMemo(owner, "k", new Date(T0.getTime() + 2_000), () => ++n)).toBe(4);
      world.db.prepare("UPDATE agents SET name = name").run();
      expect(f()).toBe(5);
    });
    expect(f()).toBe(6);
  });

  it("freeTokensAll and Bank.available inside a scope equal fresh ones, also right after a draw", () => {
    const { world, b, a } = town();
    const fresh = () => ({ free: freeTokensAll(world, T0), avail: world.bank.available(b.id, T0), rem: world.bank.remaining(b.id, T0) });
    const before = fresh();
    withTickMemo(world.db, () => {
      expect(fresh()).toEqual(before);
      expect(freeTokensAll(world, T0)).toBe(freeTokensAll(world, T0)); // one walk
      world.bank.draw(b.id, a.id, 250, { now: T0 });
      const inScope = fresh();
      expect(inScope.rem).toBe(before.rem - 250);
      expect(inScope.free.get(ROOT_GOAL_ID)!.freeTokens).toBeLessThan(before.free.get(ROOT_GOAL_ID)!.freeTokens);
    });
    expect(fresh()).toEqual(withTickMemo(world.db, fresh));
  });
});
