import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/db.ts";

const MIGRATIONS = join(fileURLToPath(import.meta.url), "..", "..", "migrations");
const SINCE = "SELECT * FROM events WHERE type IN ('bank.cap', 'budget.exhausted') AND ts >= ? ORDER BY id ASC LIMIT 5000";
const indexes = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'").all() as { name: string }[]).map((r) => r.name);
const plan = (db: Database.Database) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${SINCE}`).all("2026-10-31T00:00:00.000Z") as { detail: string }[]).map((r) => r.detail).join("\n");

describe("migration 075: events(type, ts)", () => {
  it("applies on a fresh db and the since query uses it", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(indexes(db)).toContain("events_type_ts");
    expect(plan(db)).toMatch(/events_type_ts \(type=\? AND ts>\?\)/);
  });

  it("applies on a db that already has events, and keeps them", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    cpSync(MIGRATIONS, dir, { recursive: true });
    rmSync(join(dir, "075_events_type_ts.sql"));
    const db = new Database(":memory:");
    migrate(db, dir);
    expect(indexes(db)).not.toContain("events_type_ts");
    const ins = db.prepare("INSERT INTO events (ts, type, agentId, buildingId, text, payload) VALUES (?, ?, NULL, NULL, ?, '{}')");
    for (let i = 0; i < 200; i++) ins.run(new Date(Date.UTC(2026, 9, 1) + i * 3_600_000).toISOString(), i % 2 ? "bank.cap" : "system", `e${i}`);
    expect(plan(db)).not.toMatch(/events_type_ts/);
    cpSync(join(MIGRATIONS, "075_events_type_ts.sql"), join(dir, "075_events_type_ts.sql"));
    migrate(db, dir);
    expect(indexes(db)).toContain("events_type_ts");
    expect((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(200);
    expect(plan(db)).toMatch(/events_type_ts/);
    const from = new Date(Date.UTC(2026, 9, 1) + 150 * 3_600_000).toISOString();
    expect((db.prepare(SINCE).all(from) as unknown[]).length).toBe(25);
  });
});
