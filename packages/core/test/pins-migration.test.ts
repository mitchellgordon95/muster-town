import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/db.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const PINS = "119_pins.sql";

describe("119_pins migration (design dc_8194l8soj4 §2)", () => {
  it("renames skill_pins to pins and skillId to docId, keeps the rows, adds seeded = 0, keeps one pin per doc, scope and target", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-pins-"));
    for (const f of readdirSync(MIGRATIONS)) if (f.endsWith(".sql") && f < PINS) copyFileSync(join(MIGRATIONS, f), join(dir, f));
    const db = new Database(":memory:");
    migrate(db, dir);
    db.prepare("INSERT INTO skill_pins (id, skillId, scope, targetId, mode, pinnedBy, pinnedByKind, byHuman, createdAt) VALUES ('sp_1', 'dc_s', 'town', NULL, 'always', 'us_m', 'user', 1, '2026-11-01T00:00:00Z')").run();
    copyFileSync(join(MIGRATIONS, PINS), join(dir, PINS));
    migrate(db, dir);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'skill_pins'").get()).toBeUndefined();
    expect(db.prepare("SELECT id, docId, scope, mode, byHuman, seeded FROM pins").all()).toEqual([{ id: "sp_1", docId: "dc_s", scope: "town", mode: "always", byHuman: 1, seeded: 0 }]);
    expect(() => db.prepare("INSERT INTO pins (id, docId, scope, targetId, mode, pinnedBy, pinnedByKind, createdAt) VALUES ('sp_2', 'dc_s', 'town', NULL, 'listed', 'us_m', 'user', '2026-11-02T00:00:00Z')").run()).toThrow(/UNIQUE/);
  });
});
