import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { World } from "../src/index.ts";
import { seededWorld, undoAdjustedTokens } from "./helpers.ts";

describe("migration 037: the Bank in adjusted output tokens (Bank grant step 3)", () => {
  it("converts every size once at 30 raw (Opus) / 24 raw (Fable) per adjusted token, books the ledger adjusted, and records it in a bank.converted event", () => {
    const { world, dbPath, seed } = seededWorld();
    const lab = world.buildings.require("carbon-cycle");
    world.close();
    const db = new Database(dbPath);
    undoAdjustedTokens(db);
    // the live figures before the conversion (2026-10-26), as raw sizes
    const t = "2026-10-26T00:00:00.000Z";
    const input = db.prepare("INSERT INTO bank_inputs (id, userId, label, source, model, tokens, recurrence, weeklyCapTokens, nextCreditAt, creditedTokens, hasApiKey, cancelledAt, createdAt) VALUES (?, ?, ?, 'subscription', ?, ?, 'daily', ?, NULL, ?, 0, NULL, ?)");
    input.run("bi_au5kt05vlj", seed.admin.id, "Max plan", "claude-opus-5-5", 40_000_000, 280_000_000, 240_000_000, t);
    input.run("bi_foh0utko9b", seed.admin.id, "Second plan", "claude-opus-5-5", 20_000_000, 100_000_000, 20_000_000, t);
    input.run("bi_fable", seed.admin.id, "Fable key", "claude-fable-5-1", 24_000_000, null, 0, t);
    const history = JSON.stringify([{ at: t, byId: "ag_pix", byKind: "agent", action: "propose", tokens: 24_000_000, note: "" }, { at: t, byId: "us_m", byKind: "user", action: "checkpoint", tokens: null, note: "half" }]);
    db.prepare("INSERT INTO grants (id, buildingId, objective, approach, stopCondition, askTokens, grantTokens, status, findingsDocIds, checkpointsDone, proposedBy, history, createdAt, updatedAt) VALUES ('gr_iq5m7dug56', ?, 'Bank', '', 'stop', 24000000, 24000000, 'funded', '[]', '[0.5]', 'ag_pix', ?, ?, ?)").run(lab.id, history, t, t);
    db.prepare("INSERT INTO bank_credits (id, inputId, output, cacheRead, tokens, createdAt) VALUES ('bc_1', 'bi_au5kt05vlj', 707, 29293, 30000, ?)").run(t);
    db.prepare("INSERT INTO bank_debits (id, buildingId, poolId, agentId, creditId, output, cacheRead, tokens, createdAt) VALUES ('bd_1', ?, 'general', 'ag_x', 'bc_1', 70, 2930, 3000, ?)").run(lab.id, t);
    db.prepare("UPDATE buildings SET dailyTokensPerAgent = 10000000, explorationTokensPerDay = 3000000 WHERE id = ?").run(lab.id);
    db.close();

    const w = World.open(dbPath);
    const row = (table: string, id: string) => w.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    try {
      expect(row("bank_inputs", "bi_au5kt05vlj")).toMatchObject({ tokens: 1_333_333, weeklyCapTokens: 9_333_333, creditedTokens: 8_000_000 });
      expect(row("bank_inputs", "bi_foh0utko9b")).toMatchObject({ tokens: 666_667, weeklyCapTokens: 3_333_333, creditedTokens: 666_667 });
      expect(row("bank_inputs", "bi_fable")).toMatchObject({ tokens: 1_000_000 });
      const g = w.grants.require("gr_iq5m7dug56");
      expect(g).toMatchObject({ askTokens: 800_000, grantTokens: 800_000, checkpointsDone: [0.5] });
      expect(g.history.map((h) => h.tokens)).toEqual([800_000, null]);
      expect(w.buildings.require(lab.id)).toMatchObject({ dailyTokensPerAgent: 333_333, explorationTokensPerDay: 100_000 });
      // ledger rows: tokens is the booked adjusted figure, the raw total stays alongside
      expect(row("bank_credits", "bc_1")).toMatchObject({ tokens: 1000, rawTokens: 30_000 });
      expect(row("bank_debits", "bd_1")).toMatchObject({ tokens: 99, rawTokens: 3000 });
      const ev = w.events.list({ types: ["bank.converted"] });
      expect(ev).toHaveLength(1);
      const p = ev[0].payload as { ratio: unknown; inputs: { id: string; tokens: number[] }[]; grants: { id: string; grantTokens: number[] }[] };
      expect(p.ratio).toEqual({ opus: 30, fable: 24 });
      expect(p.inputs.find((i) => i.id === "bi_au5kt05vlj")?.tokens).toEqual([40_000_000, 1_333_333]);
      expect(p.grants.find((x) => x.id === "gr_iq5m7dug56")?.grantTokens).toEqual([24_000_000, 800_000]);
    } finally {
      w.close();
    }
  });
});
