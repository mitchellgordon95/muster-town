import { Town, type Agent, type Building, type User } from "@agent-town/schema";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBuilding, createResident, createServiceAgent, createUser } from "./entities.ts";
import { buildingRoleId, townRoleId } from "./permissions.ts";
import { TOWN_HALL_ID } from "./world/layout.ts";
import type { World } from "./world.ts";

export const HOUSE_BUDGET_TOKENS = 50_000_000;

export interface SeedOptions {
  /** admin display name (default env AGENT_TOWN_ADMIN_NAME or "Mitchell") */
  adminName?: string;
  /** path to town.json (name/goal/tagline); defaults used if absent */
  townJsonPath?: string;
  /** v0 building folder to import (e.g. buildings/carbon-cycle); skipped if absent */
  importDir?: string;
  /** if set, the admin token is written to `<dataDir>/admin-token` */
  dataDir?: string;
  /** house allocation for the imported lab (default 50M tokens) */
  houseTokens?: number;
}
export interface SeedResult {
  /** false if the DB already had users (seed is idempotent) */
  created: boolean;
  admin: User;
  adminToken: string;
  townHall: Building;
  ada: Agent | null;
  lab: Building | null;
  moss: Agent | null;
}

/**
 * Seed an empty town: town.json, admin user + token, built-in roles, Town Hall with Ada (service
 * librarian at the library), optional v0 lab import + Moss (moderator) + house allocation; admin manages the lab.
 * Re-running on a seeded DB returns the existing admin/token and creates nothing.
 */
export function seedDefaults(world: World, opts: SeedOptions = {}): SeedResult {
  const existing = world.users.first("1=1", [], "ORDER BY createdAt, rowid");
  if (existing) {
    const th = world.buildings.get(TOWN_HALL_ID) ?? world.buildings.first("kind = 'town-hall'")!;
    const lab = world.buildings.first("kind = 'lab'", [], "ORDER BY createdAt") ?? null;
    return {
      created: false, admin: existing, adminToken: world.tokens.getOrCreate("user", existing.id), townHall: th,
      ada: world.agents.first("kind = 'service'") ?? null, lab,
      moss: lab ? world.agents.first("homeBuildingId = ? AND title = 'Moderator'", [lab.id]) ?? null : null,
    };
  }
  const result = world.transaction(() => {
    let town: Partial<Town> = { name: "Agent Town", goal: "", tagline: "publicly legible, collectively funded agent town for climate science" };
    if (opts.townJsonPath && existsSync(opts.townJsonPath)) {
      const raw = JSON.parse(readFileSync(opts.townJsonPath, "utf8")) as Record<string, unknown>;
      town = { ...town, ...Town.partial().parse({ name: raw.name, goal: raw.goal, tagline: raw.tagline, goalNote: raw.goalNote }) };
    }
    world.town.set(town);
    world.permissions.ensureTownRoles();
    const { user: admin, token: adminToken } = createUser(world, opts.adminName ?? process.env.AGENT_TOWN_ADMIN_NAME ?? "Mitchell");
    world.permissions.grant({ kind: "user", id: admin.id }, townRoleId("admin"));

    const townHall = createBuilding(world, {
      name: "Town Hall", goal: world.town.get().goal, description: "Library, trophy room, outbox, and the town meeting room.", headcount: 1, reviewPolicy: "human",
    }, admin.id, { id: TOWN_HALL_ID, kind: "town-hall" });
    const ada = createServiceAgent(world, { name: "Ada", title: "Librarian", placeId: "library", sprite: 0 });

    let lab: Building | null = null, moss: Agent | null = null;
    if (opts.importDir && existsSync(join(opts.importDir, "building.json"))) {
      lab = world.importV0(opts.importDir, { creatorUserId: admin.id }).building;
      moss = createResident(world, {
        buildingId: lab.id, name: "Moss", title: "Moderator", sprite: 7,
        direction: "Review reports for this building: sources present, numbers carry units and uncertainty, the proposal is one concrete question, and it doesn't duplicate the board. Facilitate meetings.",
      });
      world.permissions.grant(moss, buildingRoleId(lab.id, "moderator"));
      world.budget.donate(admin.id, { tokens: opts.houseTokens ?? HOUSE_BUDGET_TOKENS, buildingId: lab.id });
    }
    world.events.append({ type: "system", text: "Town seeded", payload: { adminId: admin.id, labId: lab?.id ?? null } });
    return { created: true, admin: world.users.require(admin.id), adminToken, townHall: world.buildings.require(townHall.id), ada, lab, moss };
  });
  if (opts.dataDir) {
    mkdirSync(opts.dataDir, { recursive: true });
    writeFileSync(join(opts.dataDir, "admin-token"), result.adminToken + "\n", { mode: 0o600 });
  }
  return result;
}
