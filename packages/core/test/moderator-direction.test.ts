/** Migration 046: a moderator seeded with the old "approve outbox requests" default gets the gate-free default; custom wording stays. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTownModerator } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "046_moderator_direction.sql"), "utf8");
const OLD = "Collective-wide misuse prevention: approve outbox requests that are safe and useful, review trophy proposals, and ban agents that misuse the town. Every building keeps its own policies; you don't review research.";

describe("migration 046", () => {
  it("rewrites the old default direction to today's default and leaves custom wording alone", () => {
    const { world } = seededWorld();
    const fresh = createTownModerator(world, { name: "Fresh" });
    const old = createTownModerator(world, { name: "Old" });
    const custom = createTownModerator(world, { name: "Custom", direction: "Approve outbox requests about soil only." });
    world.agents.patch(old.id, { direction: OLD });
    world.db.exec(SQL);
    expect(world.agents.require(old.id).direction).toBe(fresh.direction);
    expect(world.agents.require(old.id).direction).not.toMatch(/approve/i);
    expect(world.agents.require(custom.id).direction).toBe("Approve outbox requests about soil only.");
  });
});
