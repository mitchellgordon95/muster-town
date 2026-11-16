import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { World } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const CUT = "2026-10-27T00:00:24.216Z";

describe("migration 117: the ledger starts at the bank.converted event (town meeting mt_dm14dgejml decision 4)", () => {
  it("deletes the records from before the cutoff, keeps what later rows still draw on, records counts, and leaves `left` unchanged", () => {
    const { world, dbPath, seed } = seededWorld();
    const lab = world.buildings.require("carbon-cycle");
    world.close();
    let db = new Database(dbPath);
    db.prepare("INSERT INTO events (ts, type, text, payload) VALUES (?, 'bank.converted', 'converted', '{}')").run(CUT);
    const input = db.prepare("INSERT INTO bank_inputs (id, userId, label, source, model, tokens, recurrence, weeklyCapTokens, nextCreditAt, creditedTokens, hasApiKey, cancelledAt, createdAt) VALUES (?, ?, ?, ?, 'claude-opus-5-5', 1000, ?, NULL, NULL, 1000, 0, ?, ?)");
    input.run("bi_old", seed.admin.id, "old plan", "subscription", "daily", "2026-10-21T00:00:00.000Z", "2026-10-20T00:00:00.000Z");
    input.run("bi_edge", seed.admin.id, "plan across the cutoff", "subscription", "daily", "2026-10-27T02:59:00.000Z", "2026-10-26T23:31:00.000Z");
    input.run("bi_live", seed.admin.id, "plan still running", "subscription", "daily", null, "2026-10-20T00:00:00.000Z");
    const credit = db.prepare("INSERT INTO bank_credits (id, inputId, output, tokens, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?)");
    credit.run("bc_old", "bi_old", 1000, 1000, "2026-10-20T00:00:00.000Z", "2026-10-21T00:00:00.000Z");
    credit.run("bc_edge", "bi_edge", 500, 500, "2026-10-26T23:31:00.000Z", "2026-10-27T23:31:00.000Z");
    credit.run("bc_live_old", "bi_live", 700, 700, "2026-10-20T00:00:00.000Z", "2026-10-21T00:00:00.000Z");
    const debit = db.prepare("INSERT INTO bank_debits (id, buildingId, poolId, agentId, creditId, output, tokens, createdAt) VALUES (?, ?, 'general', 'ag_x', ?, ?, ?, ?)");
    debit.run("bd_old", lab.id, "bc_old", 600, 600, "2026-10-20T01:00:00.000Z");
    debit.run("bd_edge_pre", lab.id, "bc_edge", 100, 100, "2026-10-26T23:50:00.000Z");
    debit.run("bd_edge_post", lab.id, "bc_edge", 200, 200, "2026-10-27T01:00:00.000Z");
    const usage = db.prepare("INSERT INTO usage (id, agentId, buildingId, output, tokens, usd, createdAt) VALUES (?, 'ag_x', ?, ?, ?, 0, ?)");
    usage.run("us_old", lab.id, 600, 600, "2026-10-20T01:00:00.000Z");
    usage.run("us_new", lab.id, 200, 200, "2026-10-27T01:00:00.000Z");
    const alloc = db.prepare("INSERT INTO allocations (id, userId, buildingId, tokens, spentTokens, spentUsd, createdAt, retired) VALUES (?, ?, ?, 1000, ?, 0, '2026-10-20T00:00:00.000Z', ?)");
    alloc.run("al_old", seed.admin.id, lab.id, 1066, 1);
    alloc.run("al_live", seed.admin.id, lab.id, 10, 0);
    const session = db.prepare("INSERT INTO sessions (id, agentId, purpose, status, model, output, startedAt, endedAt) VALUES (?, 'ag_x', 'work', ?, 'claude-opus-5-5', 30000, ?, ?)");
    session.run("se_old", "done", "2026-10-25T00:00:00.000Z", "2026-10-25T01:00:00.000Z");
    session.run("se_across", "done", "2026-10-26T23:00:00.000Z", "2026-10-27T01:00:00.000Z");
    session.run("se_open", "running", "2026-10-25T00:00:00.000Z", null);
    db.close();

    // the figures before the cutoff runs (117 is already recorded on the seeded world, so opening it changes nothing)
    let w = World.open(dbPath);
    const before = w.bank.finance(new Date("2026-11-16T18:00:00.000Z"));
    expect(before.cutoff).toBeNull();
    w.close();

    db = new Database(dbPath);
    db.prepare("DELETE FROM schema_version WHERE version = 117").run();
    db.close();
    w = World.open(dbPath);
    try {
      const has = (table: string, id: string) => !!w.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
      // gone: everything from before the cutoff that nothing after it draws on
      for (const [t, id] of [["bank_inputs", "bi_old"], ["bank_credits", "bc_old"], ["bank_credits", "bc_live_old"], ["bank_debits", "bd_old"], ["bank_debits", "bd_edge_pre"], ["usage", "us_old"], ["allocations", "al_old"], ["sessions", "se_old"]] as const) {
        expect(has(t, id), `${t} ${id} deleted`).toBe(false);
      }
      // kept: a credit a later debit draws on (and its input), an input still running, a live donation, sessions that ended after or still run
      for (const [t, id] of [["bank_inputs", "bi_edge"], ["bank_inputs", "bi_live"], ["bank_credits", "bc_edge"], ["bank_debits", "bd_edge_post"], ["usage", "us_new"], ["allocations", "al_live"], ["sessions", "se_across"], ["sessions", "se_open"]] as const) {
        expect(has(t, id), `${t} ${id} kept`).toBe(true);
      }
      const after = w.bank.finance(new Date("2026-11-16T18:00:00.000Z"));
      expect(after.left).toBe(before.left);
      expect(after.sumCheck.ok).toBe(true);
      expect(before.used - after.used).toBe(600 + 100 + 1066);
      expect(before.usageLedger - after.usageLedger).toBe(600);
      expect(after.cutoff).toMatchObject({
        at: CUT,
        removed: { sessions: 1, usage: 1, debits: 2, credits: 2, inputs: 1, allocations: 1 },
        tokens: { usage: 600, debits: 700, credits: 1700, donated: 1000, donationsSpent: 1066 },
      });
      expect(w.bank.spend(new Date("2026-11-16T18:00:00.000Z")).cutoff?.at).toBe(CUT);
      const ev = w.events.list({ types: ["bank.pruned"] });
      expect(ev).toHaveLength(1);
      expect(ev[0].text).toContain("1 sessions, 1 usage rows, 2 debits, 2 credits, 1 inputs, 1 donations");
    } finally {
      w.close();
    }
  });

  it("writes nothing on a world with nothing from before the cutoff", () => {
    const { world } = seededWorld();
    try {
      expect(world.bank.finance().cutoff).toBeNull();
      expect(world.events.list({ types: ["bank.pruned"] })).toHaveLength(0);
    } finally {
      world.close();
    }
  });
});
