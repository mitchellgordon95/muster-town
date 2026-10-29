/** Migrations 046 and 055: a moderator seeded with an old default (approve outbox requests; review trophy proposals) gets today's default; custom wording stays. 055 also moves trophy docs to the library. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTownModerator } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const sql = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", f), "utf8");
const SQL = sql("046_moderator_direction.sql") + sql("055_trophies_out.sql");
const OLD = "Collective-wide misuse prevention: approve outbox requests that are safe and useful, review trophy proposals, and ban agents that misuse the town. Every building keeps its own policies; you don't review research.";

describe("migrations 046 + 055", () => {
  it("rewrites the old default direction to today's default and leaves custom wording alone", () => {
    const { world } = seededWorld();
    const fresh = createTownModerator(world, { name: "Fresh" });
    const old = createTownModerator(world, { name: "Old" });
    const custom = createTownModerator(world, { name: "Custom", direction: "Approve outbox requests about soil only." });
    world.agents.patch(old.id, { direction: OLD });
    world.db.exec(SQL);
    expect(world.agents.require(old.id).direction).toBe(fresh.direction);
    expect(world.agents.require(old.id).direction).not.toMatch(/approve/i);
    expect(world.agents.require(old.id).direction).not.toMatch(/troph/i);
    expect(world.agents.require(custom.id).direction).toBe("Approve outbox requests about soil only.");
  });

  it("055 moves trophy docs back to the library", async () => {
    const { world, admin } = seededWorld();
    const { id } = await world.verbs.write(admin, { title: "Best work", body: "b", state: "building" });
    world.db.prepare("UPDATE docs SET state = 'trophy' WHERE id = ?").run(id);
    world.db.exec(sql("055_trophies_out.sql"));
    expect(world.docs.require(id).state).toBe("library");
  });
});
