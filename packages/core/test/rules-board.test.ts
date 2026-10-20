import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate, workSystemPrompt, reviewSystemPrompt } from "../src/index.ts";
import { seededWorld, tempDir } from "./helpers.ts";

describe("building board and standing rules", () => {
  it("the board lists articles and notes but not reports (reports stay in the in-tray)", async () => {
    const { world, by } = seededWorld();
    const mei = by("Mei");
    const note = await world.verbs.write(mei, { type: "note", title: "scratch", body: "x", state: "building" });
    const rep = await world.verbs.submit_report(mei, { title: "Run 1", body: "## Summary\nok", verdict: "continue" });
    const board = await world.verbs.board(mei, { limit: 50 });
    const ids = board.docs.map((d) => d.id);
    expect(ids).toContain(note.id);
    expect(ids).not.toContain(rep.id);
    expect(board.docs.some((d) => d.type === "report")).toBe(false);
    expect(world.ops.intray("carbon-cycle").map((d) => d.id)).toContain(rep.id);
  });

  it("a manager's standing rules go into work and review system prompts; members can't set them", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    expect(() => world.ops.updateBuilding(mei, "carbon-cycle", { rules: "nope" })).toThrow(/building.manage/);
    const b = world.ops.updateBuilding(admin, "carbon-cycle", { rules: "- Cite NOAA GML for CO2 levels." });
    expect(b.rules).toBe("- Cite NOAA GML for CO2 levels.");
    const town = world.town.get();
    expect(workSystemPrompt(mei, b, town)).toContain("Standing rules for the Carbon Cycle Lab");
    expect(workSystemPrompt(mei, b, town)).toContain("- Cite NOAA GML for CO2 levels.");
    expect(reviewSystemPrompt(mei, b)).toContain("- Cite NOAA GML for CO2 levels.");
    // empty rules add nothing
    const none = world.ops.updateBuilding(admin, "carbon-cycle", { rules: "  " });
    expect(workSystemPrompt(mei, none, town)).not.toContain("Standing rules");
  });
});

describe("migrate", () => {
  it("applies a lower-numbered migration that arrives after a higher one (branches merged out of order)", () => {
    const dir = join(tempDir(), "m");
    mkdirSync(dir);
    writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE a (x INTEGER);");
    writeFileSync(join(dir, "003_c.sql"), "CREATE TABLE c (x INTEGER);");
    const db = new Database(":memory:");
    expect(migrate(db, dir)).toBe(3);
    writeFileSync(join(dir, "002_b.sql"), "CREATE TABLE b (x INTEGER);");
    expect(migrate(db, dir)).toBe(3);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").get()).toBeTruthy();
    expect((db.prepare("SELECT version FROM schema_version ORDER BY version").all() as { version: number }[]).map((r) => r.version)).toEqual([1, 2, 3]);
    migrate(db, dir); // idempotent
    db.close();
  });
});
