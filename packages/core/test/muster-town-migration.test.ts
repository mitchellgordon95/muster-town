import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/db.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const RENAME = "018_muster_town.sql";

/** A DB migrated up to just before the rename, so we can plant old data and then apply it. */
function preRenameDb() {
  const dir = mkdtempSync(join(tmpdir(), "mig-muster-"));
  for (const f of readdirSync(MIGRATIONS)) if (f.endsWith(".sql") && f < RENAME) copyFileSync(join(MIGRATIONS, f), join(dir, f));
  const db = new Database(":memory:");
  migrate(db, dir);
  const applyRename = () => { copyFileSync(join(MIGRATIONS, RENAME), join(dir, RENAME)); migrate(db, dir); };
  return { db, applyRename };
}

const town = (db: Database.Database) => JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'town'").get() as { value: string }).value);
const building = (db: Database.Database, id: string) => db.prepare("SELECT goal, description FROM buildings WHERE id = ?").get(id) as { goal: string | null; description: string | null };
const addBuilding = (db: Database.Database, id: string, goal: string | null, description: string | null) =>
  db.prepare("INSERT INTO buildings (id, name, kind, goal, description, headcount, reviewPolicy, createdAt) VALUES (?, ?, 'lab', ?, ?, 1, 'manager', '2026-10-20T00:00:00Z')").run(id, id, goal, description);

describe("018_muster_town migration", () => {
  it("rewrites the seeded town name, goal, tagline and building text that still say Agent Town", () => {
    const { db, applyRename } = preRenameDb();
    db.prepare("INSERT INTO meta (key, value) VALUES ('town', ?)").run(JSON.stringify({
      name: "Agent Town", goal: "Make Agent Town something strangers can fund, join, and trust",
      tagline: "publicly legible, collectively funded agent town for building Agent Town", extra: 1,
    }));
    db.prepare("INSERT INTO meta (key, value) VALUES ('desks', ?)").run(JSON.stringify({ image: "agent-town-desk" }));
    addBuilding(db, "workshop", "Ship improvements to Agent Town as small, reviewed pull requests", "The building that works on Agent Town itself.");
    applyRename();
    expect(town(db)).toEqual({
      name: "Muster Town", goal: "Make Muster Town something strangers can fund, join, and trust",
      // lowercase "agent town" is a description, not the name: left alone
      tagline: "publicly legible, collectively funded agent town for building Muster Town", extra: 1,
    });
    expect(building(db, "workshop")).toEqual({ goal: "Ship improvements to Muster Town as small, reviewed pull requests", description: "The building that works on Muster Town itself." });
    // the desk image switches in the host cutover (P5), once muster-town-desk is built
    expect(JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'desks'").get() as { value: string }).value)).toEqual({ image: "agent-town-desk" });
  });

  it("leaves fields that no longer hold the old literal untouched", () => {
    const { db, applyRename } = preRenameDb();
    db.prepare("INSERT INTO meta (key, value) VALUES ('town', ?)").run(JSON.stringify({ name: "Climate Town", goal: "Understand the carbon cycle" }));
    addBuilding(db, "lab", "Measure ocean uptake", null);
    addBuilding(db, "empty", null, null);
    applyRename();
    expect(town(db)).toEqual({ name: "Climate Town", goal: "Understand the carbon cycle" });
    expect(building(db, "lab")).toEqual({ goal: "Measure ocean uptake", description: null });
    expect(building(db, "empty")).toEqual({ goal: null, description: null });
  });

  it("runs on a fresh DB with no town row", () => {
    const { db, applyRename } = preRenameDb();
    applyRename();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'town'").get()).toBeUndefined();
  });

  it("019 rewrites agent directions/titles and building rules that 018 missed", () => {
    const { db, applyRename } = preRenameDb();
    addBuilding(db, "workshop", null, null);
    db.prepare("UPDATE buildings SET rules = 'Ship Agent Town fixes to main.' WHERE id = 'workshop'").run();
    const addAgent = (id: string, title: string | null, direction: string | null) =>
      db.prepare("INSERT INTO agents (id, name, kind, title, direction, pos, status, createdAt) VALUES (?, ?, 'resident', ?, ?, '{}', 'idle', '2026-10-20T00:00:00Z')").run(id, id, title, direction);
    addAgent("sage", "Agent Town designer", "What Agent Town should become: the public collective.");
    addAgent("moss", "Reviewer", null);
    applyRename();
    migrate(db, MIGRATIONS); // the rest, including 019
    const agent = (id: string) => db.prepare("SELECT title, direction FROM agents WHERE id = ?").get(id);
    expect(agent("sage")).toEqual({ title: "Muster Town designer", direction: "What Muster Town should become: the public collective." });
    expect(agent("moss")).toEqual({ title: "Reviewer", direction: null });
    expect(db.prepare("SELECT rules FROM buildings WHERE id = 'workshop'").get()).toEqual({ rules: "Ship Muster Town fixes to main." });
  });
});
