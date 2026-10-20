import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db.ts";

describe("migrate", () => {
  it("applies a migration whose number is below the max recorded version", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "001_init.sql"), "CREATE TABLE t (id INTEGER);");
    writeFileSync(join(dir, "003_later.sql"), "ALTER TABLE t ADD COLUMN c INTEGER;");
    const db = new Database(":memory:");
    expect(migrate(db, dir)).toBe(3);
    // 002 lands after 003 already ran (merged late)
    writeFileSync(join(dir, "002_late.sql"), "ALTER TABLE t ADD COLUMN b INTEGER;");
    expect(migrate(db, dir)).toBe(3);
    const cols = (db.prepare("PRAGMA table_info(t)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["id", "c", "b"]);
    expect((db.prepare("SELECT version FROM schema_version ORDER BY version").all() as { version: number }[]).map((r) => r.version)).toEqual([1, 2, 3]);
    // re-running is a no-op
    expect(migrate(db, dir)).toBe(3);
  });
});
