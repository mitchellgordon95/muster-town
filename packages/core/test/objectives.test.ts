/** Objectives are goals (grant gr_h4m0lyhb1f step 1): migration 124 keeps every objective as a goal, then drops the table. */
import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db.ts";
import { buildingRoleId, keyResultsBlock } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const KR = { text: "A visitor can see today's spend on the banner", howToCheck: "Open the lab banner, read Usage" };

describe("objectives are goals", () => {
  it("migration 124 writes an objective with no goal row as a goal under its building's attachment, then drops the table", () => {
    const all = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    const dir = mkdtempSync(join(tmpdir(), "mig-ob-"));
    for (const f of readdirSync(all)) if (Number(/^(\d+)/.exec(f)?.[1]) < 124) copyFileSync(join(all, f), join(dir, f));
    const db = new Database(":memory:");
    migrate(db, dir);
    const now = "2026-11-19T00:00:00.000Z";
    db.prepare("INSERT INTO goals (id, parentId, position, text, createdAt, updatedAt) VALUES ('gl_lab', 'gl_town', 9, 'Lab goal', ?, ?)").run(now, now);
    db.prepare("INSERT INTO buildings (id, name, kind, headcount, goal, goalId, createdAt) VALUES ('bl_lab', 'Lab', 'lab', 1, 'g', 'gl_lab', ?)").run(now);
    const ob = db.prepare("INSERT INTO objectives (id, buildingId, position, text, horizon, updatedAt) VALUES (?, 'bl_lab', ?, ?, '2026-Q4', ?)");
    ob.run("ob_kept", 0, "Already a goal", now);
    db.prepare("INSERT INTO goals (id, parentId, position, text, createdAt, updatedAt) VALUES ('ob_kept', 'gl_lab', 0, 'Already a goal', ?, ?)").run(now, now);
    ob.run("ob_lost", 1, "Never made a goal", now);
    copyFileSync(join(all, "124_drop_objectives.sql"), join(dir, "124_drop_objectives.sql"));
    migrate(db, dir);
    expect(db.prepare("SELECT id, parentId, text FROM goals WHERE id LIKE 'ob_%' ORDER BY id").all()).toEqual([
      { id: "ob_kept", parentId: "gl_lab", text: "Already a goal" },
      { id: "ob_lost", parentId: "gl_lab", text: "Never made a goal" },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'objectives'").get()).toBeUndefined();
  });

  it("the desk brief lists the building's subtree: each goal under its attachment with its grants' open key results", () => {
    const s = seededWorld();
    const { world, by, admin } = s;
    const mei = by("Mei");
    world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
    world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
    const propose = (text: string, goalId?: string) => world.grantDesk.propose(mei, world.grantDesk.create(mei, LAB, { goalId, keyResults: [{ ...KR, text }], objective: `Plan: ${text}`, steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "s", askTokens: 1000 }).id);
    const loose = propose("Loose one");
    const lab = world.buildings.require(LAB);
    const sub = world.goalTree.create(admin, { parentId: world.goalTree.attachmentOf(lab), text: "Strangers can join" });
    const g = propose(KR.text, sub.id);
    const block = keyResultsBlock(world, world.buildings.require(LAB));
    expect(block).toContain("Attached to: ");
    expect(block).toMatch(new RegExp(`  Goal ${sub.id}: Strangers can join\n    - grant ${g.id} [^\n]*\n        - ${g.keyResults[0]!.id} \\[open\\] A visitor can see`));
    expect(block).toMatch(new RegExp(`- grant ${loose.id} [^\n]*\n      - ${loose.keyResults[0]!.id} \\[open\\] Loose one`));
  });
});
