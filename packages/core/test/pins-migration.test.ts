import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
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

describe("120_town_pins migration (design dc_8194l8soj4 §4): the back-fill", () => {
  it("pins the first manual and ledger always and the first dictionary listed, town-wide and seeded; skips drafts and later copies; a second run adds nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-town-pins-"));
    const TOWN = "120_town_pins.sql";
    for (const f of readdirSync(MIGRATIONS)) if (f.endsWith(".sql") && f < TOWN) copyFileSync(join(MIGRATIONS, f), join(dir, f));
    const db = new Database(":memory:");
    migrate(db, dir);
    const doc = db.prepare("INSERT INTO docs (id, type, state, title, body, authorId, authorKind, buildingId, tags, createdAt, updatedAt) VALUES (?, ?, ?, 't', 'b', 'ag_s', 'agent', ?, ?, ?, ?)");
    const add = (id: string, type: string, state: string, tags: string[], at: string, building = "town-hall") => doc.run(id, type, state, building, JSON.stringify(tags), at, at);
    add("dc_draft", "article", "draft", ["operating-manual"], "2026-11-01T00:00:00Z");
    add("dc_manual", "article", "library", ["operating-manual"], "2026-11-02T00:00:00Z");
    add("dc_manual2", "note", "building", ["operating-manual"], "2026-11-03T00:00:00Z");
    add("dc_elsewhere", "article", "library", ["operating-manual"], "2026-10-01T00:00:00Z", "bl_x");
    add("dc_ledger", "policy", "building", ["policy-ledger"], "2026-11-01T00:00:00Z");
    add("dc_ledger2", "policy", "building", [], "2026-11-05T00:00:00Z");
    add("dc_dict", "dictionary", "building", ["dictionary"], "2026-11-01T00:00:00Z");
    copyFileSync(join(MIGRATIONS, TOWN), join(dir, TOWN));
    migrate(db, dir);
    const rows = () => db.prepare("SELECT docId, scope, targetId, mode, seeded, pinnedBy FROM pins ORDER BY docId").all();
    const want = [
      { docId: "dc_dict", scope: "town", targetId: null, mode: "listed", seeded: 1, pinnedBy: "system" },
      { docId: "dc_ledger", scope: "town", targetId: null, mode: "always", seeded: 1, pinnedBy: "system" },
      { docId: "dc_manual", scope: "town", targetId: null, mode: "always", seeded: 1, pinnedBy: "system" },
    ];
    expect(rows()).toEqual(want);
    // the same statements again (as if it ran twice) leave the table as it was
    db.exec(readFileSync(join(MIGRATIONS, TOWN), "utf8"));
    expect(rows()).toEqual(want);
  });
});

describe("121_page_pins migration (design dc_8194l8soj4 §3-4, step 3): the back-fill", () => {
  it("pins published topic pages building/listed, a manager's private pages agent/listed, Town Hall town pages town/listed; skips drafts, residents' pages and untagged docs; a second run adds nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-page-pins-"));
    const PAGES = "121_page_pins.sql";
    for (const f of readdirSync(MIGRATIONS)) if (f.endsWith(".sql") && f < PAGES) copyFileSync(join(MIGRATIONS, f), join(dir, f));
    const db = new Database(":memory:");
    migrate(db, dir);
    const cols = (db.prepare("PRAGMA table_info(buildings)").all() as { name: string; notnull: number; dflt_value: unknown }[]).filter((c) => c.notnull && c.dflt_value == null).map((c) => c.name);
    const bld = (id: string, manager: string | null) => {
      const vals: Record<string, unknown> = Object.fromEntries(cols.map((c) => [c, c === "id" ? id : c === "name" ? id : 0]));
      vals.managerAgentId = manager;
      const keys = Object.keys(vals);
      db.prepare(`INSERT INTO buildings (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => vals[k]));
    };
    bld("bl_a", "ag_boss");
    bld("bl_b", null);
    const doc = db.prepare("INSERT INTO docs (id, type, state, title, body, authorId, authorKind, buildingId, topicOf, tags, createdAt, updatedAt) VALUES (?, ?, ?, 't', 'b', ?, 'agent', ?, ?, ?, ?, ?)");
    const at = "2026-11-01T00:00:00Z";
    const add = (id: string, type: string, state: string, author: string, building: string, topicOf: string | null, tags: string[] = []) => doc.run(id, type, state, author, building, topicOf, JSON.stringify(tags), at, at);
    add("dc_topic", "wiki", "building", "ag_boss", "bl_a", "bl_a");
    add("dc_topicdraft", "wiki", "draft", "ag_boss", "bl_a", "bl_a");
    add("dc_bosswiki", "wiki", "draft", "ag_boss", "bl_a", null);
    add("dc_reswiki", "wiki", "draft", "ag_res", "bl_a", null);
    add("dc_townpage", "article", "building", "ag_sec", "town-hall", null, ["town-page"]);
    add("dc_townpagedraft", "article", "draft", "ag_sec", "town-hall", null, ["town-page"]);
    add("dc_elsewhere", "article", "building", "ag_boss", "bl_a", null, ["town-page"]);
    add("dc_note", "note", "building", "ag_sec", "town-hall", null);
    copyFileSync(join(MIGRATIONS, PAGES), join(dir, PAGES));
    migrate(db, dir);
    const rows = () => db.prepare("SELECT docId, scope, targetId, mode, seeded, pinnedBy FROM pins ORDER BY docId").all();
    const want = [
      { docId: "dc_bosswiki", scope: "agent", targetId: "ag_boss", mode: "listed", seeded: 1, pinnedBy: "system" },
      { docId: "dc_topic", scope: "building", targetId: "bl_a", mode: "listed", seeded: 1, pinnedBy: "system" },
      { docId: "dc_townpage", scope: "town", targetId: null, mode: "listed", seeded: 1, pinnedBy: "system" },
    ];
    expect(rows()).toEqual(want);
    db.exec(readFileSync(join(MIGRATIONS, PAGES), "utf8"));
    expect(rows()).toEqual(want);
  });
});
