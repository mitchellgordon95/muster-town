/** Migration 055 moves trophy docs to the library. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { seededWorld } from "./helpers.ts";

const sql = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", f), "utf8");

describe("migration 055", () => {
  it("055 moves trophy docs back to the library", async () => {
    const { world, admin } = seededWorld();
    const { id } = await world.verbs.write(admin, { title: "Best work", body: "b", state: "building" });
    world.db.prepare("UPDATE docs SET state = 'trophy' WHERE id = ?").run(id);
    world.db.exec(sql("055_trophies_out.sql"));
    expect(world.docs.require(id).state).toBe("library");
  });
});
