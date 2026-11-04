import { afterEach, describe, expect, it, vi } from "vitest";
import { ROOT_GOAL_ID } from "@muster-town/schema";
import { createBuilding, createResident, freeTokensAll, type World } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

// gr_db6ofyd0yf step 2: migration 089's covering index bank_debits(creditId, tokens). Bank.debited's sums must read it
// (not scan the table) and every Bank figure must be the same with and without it.
const T0 = new Date("2026-11-04T12:00:00.000Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(T0.getTime() + days * DAY);

/** Every Bank figure the runtime tick and the Bank pages read. */
function figures(world: World, buildingIds: string[], now: Date) {
  return {
    balance: world.bank.balance(now),
    usable: world.bank.usableBalance(now),
    unavailable: world.bank.unavailable(now),
    available: buildingIds.map((b) => world.bank.available(b, now)),
    remaining: buildingIds.map((b) => world.bank.remaining(b, now)),
    inputBalances: (world.db.prepare("SELECT id FROM bank_inputs ORDER BY rowid").all() as { id: string }[]).map((i) => world.bank.inputBalance(i.id, now)),
    free: freeTokensAll(world, now),
    summary: world.bank.summary(),
    finance: world.bank.finance(now),
  };
}

function populated() {
  const { world, seed } = seededWorld();
  const b = createBuilding(world, { name: "Banked" }, seed.admin.id);
  const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
  // a daily subscription (expiring credits, one expired), two keys (one broken, one cancelled), an earmark, a credit no debit names
  const sub = world.bank.addInput(seed.admin.id, { label: "Max plan", source: "subscription", token: "sk-ant-oat01-test-token", model: "m", tokens: 400, recurrence: "daily", weeklyCapTokens: 100_000 }, T0);
  const key = world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: "m", tokens: 1000, apiKey: "sk" }, T0);
  const k2 = world.bank.addInput(seed.admin.id, { label: "Key 2", source: "api-key", model: "m", tokens: 800, apiKey: "sk2" }, T0);
  world.bank.addInput(seed.admin.id, { label: "Unspent", source: "api-key", model: "m", tokens: 50, apiKey: "sk3" }, T0);
  world.bank.addInput(seed.admin.id, { label: "Earmark", source: "api-key", model: "m", tokens: 300, apiKey: "sk-e", goalId: ROOT_GOAL_ID } as never, T0);
  world.bank.draw(b.id, a.id, 250, { now: T0 });
  world.bank.creditDue(at(1));
  world.bank.draw(b.id, a.id, 900, { now: at(1) });
  world.bank.draw(b.id, a.id, 120, { now: at(1) });
  world.bank.cancelInput(seed.admin.id, k2.id, at(1));
  // a broken key: its durable credit counts as unavailable
  world.bank.availability.recordFailure({ inputId: key.id, model: "m", text: "Your credit balance is too low" }, at(1));
  // a debit naming no credit (the general pool's anonymous draws before credits were named)
  world.db.prepare("INSERT INTO bank_debits (id, buildingId, agentId, creditId, createdAt, poolId, input, output, cacheRead, tokens) VALUES ('bd_anon', ?, ?, NULL, ?, 'general', 0, 40, 0, 40)").run(b.id, a.id, at(1).toISOString());
  return { world, ids: world.buildings.all().map((x) => x.id), sub };
}

describe("bank_debits credit index (migration 089)", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("Bank.debited's sums read the index, never scan bank_debits", () => {
    const { world } = populated();
    const plan = (where: string) => (world.db.prepare(`EXPLAIN QUERY PLAN SELECT COALESCE(SUM("tokens"), 0) AS n FROM "bank_debits" WHERE ${where}`).all("x") as { detail: string }[]).map((r) => r.detail).join(" | ");
    expect(plan("creditId = ?")).toMatch(/COVERING INDEX bank_debits_credit/);
    const durable = plan("creditId IS NULL OR creditId IN (SELECT id FROM bank_credits WHERE expiresAt IS NULL AND inputId NOT IN (SELECT id FROM bank_inputs WHERE goalId IS NOT NULL)) AND ? IS NOT NULL");
    expect(durable).toMatch(/bank_debits_credit/);
    expect(durable).not.toMatch(/SCAN bank_debits/);
  });

  it("every Bank figure is identical with the index dropped (the old full scans) and present", () => {
    const { world, ids } = populated();
    vi.useFakeTimers({ toFake: ["Date"], now: at(1) }); // summary() reads the wall clock
    for (const now of [at(1), at(1.5), at(3)]) {
      const withIndex = figures(world, ids, now);
      world.db.exec("DROP INDEX bank_debits_credit");
      const without = figures(world, ids, now);
      world.db.exec("CREATE INDEX bank_debits_credit ON bank_debits(creditId, tokens)");
      expect(withIndex).toEqual(without);
    }
    // the fixture really exercises each path
    const f = figures(world, ids, at(1));
    expect(f.unavailable.tokens).toBeGreaterThan(0);
    expect(f.balance).toBeGreaterThan(0);
  });
});
