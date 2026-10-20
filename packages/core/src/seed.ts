import { CollectiveConfig, Town, type Agent, type Building, type User } from "@agent-town/schema";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createBuilding, createResident, createServiceAgent, createTownModerator, createUser } from "./entities.ts";
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
  /** path to collective.json; its buildings (imports, residents, workspaces, reviewers) and town moderators are created at seed */
  collectivePath?: string;
}
export interface SeedResult {
  /** false if the DB already had users (seed is idempotent) */
  created: boolean;
  admin: User;
  adminToken: string;
  townHall: Building;
  ada: Agent | null;
  lab: Building | null;
  /** the first lab's reviewer agent (historically Moss) */
  moss: Agent | null;
  /** town moderators created at seed (none on an existing DB) */
  moderators: Agent[];
}

const REVIEWER_DIRECTION = "Work this building's in-tray: check each report against the criteria (sources present, numbers carry units and uncertainty, the proposal is one concrete question, no duplication of the board) and decide: continue when the proposal should be the author's next assignment, approve to acknowledge without follow-up, redirect with a concrete note, stop when the direction is exhausted. Facilitate meetings.";

/** The building's reviewer agent (role `reviewer`), if any. */
function reviewerOf(world: World, buildingId: string): Agent | null {
  const id = world.permissions.agentsWithRole(buildingRoleId(buildingId, "reviewer"))[0];
  return id ? world.agents.get(id) ?? null : null;
}

/** `git -C <path> remote get-url origin`, or undefined when `path` isn't a git repo / has no origin. */
export function originUrl(path: string): string | undefined {
  try {
    const url = execFileSync("git", ["-C", path, "remote", "get-url", "origin"], { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).toString().trim();
    return url || undefined;
  } catch {
    return undefined;
  }
}

/** A workspace spec gets `repoUrl` from its repo's origin unless given directly. */
function withRepoUrl<W extends { path: string; repoUrl?: string }>(ws: W): W {
  if (ws.repoUrl) return ws;
  const repoUrl = originUrl(ws.path);
  return repoUrl ? { ...ws, repoUrl } : ws;
}

/**
 * Seed an empty town: town.json, admin user + token, built-in roles, Town Hall with Ada (service
 * librarian at the library), optional v0 lab import + Moss (reviewer) + house allocation; admin manages the lab;
 * collective.json buildings and town moderators (seated at the mod station).
 * Re-running on a seeded DB returns the existing admin/token and creates no agents (it backfills workspace repoUrl
 * and makes sure the built-in town roles, including v1.2's `moderator`, exist).
 */
export function seedDefaults(world: World, opts: SeedOptions = {}): SeedResult {
  const existing = world.users.first("1=1", [], "ORDER BY createdAt, rowid");
  if (existing) {
    // backfill repoUrl for workspaces seeded before desks existed
    for (const b of world.buildings.all()) {
      if (b.workspace && !b.workspace.repoUrl && b.workspace.path) {
        const ws = withRepoUrl(b.workspace);
        if (ws.repoUrl) world.buildings.patch(b.id, { workspace: ws });
      }
    }
    // v1.2: the town moderator role (no moderator agents are created in existing DBs)
    world.permissions.ensureTownRoles();
    const th = world.buildings.get(TOWN_HALL_ID) ?? world.buildings.first("kind = 'town-hall'")!;
    const lab = world.buildings.first("kind = 'lab'", [], "ORDER BY createdAt") ?? null;
    return {
      created: false, admin: existing, adminToken: world.tokens.getOrCreate("user", existing.id), townHall: th,
      ada: world.agents.first("kind = 'service'") ?? null, lab,
      moss: lab ? reviewerOf(world, lab.id) : null, moderators: [],
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
      moss = createResident(world, { buildingId: lab.id, name: "Moss", title: "Reviewer", sprite: 7, direction: REVIEWER_DIRECTION });
      world.permissions.grant(moss, buildingRoleId(lab.id, "reviewer"));
      world.budget.donate(admin.id, { tokens: opts.houseTokens ?? HOUSE_BUDGET_TOKENS, buildingId: lab.id });
    }
    const moderators: Agent[] = [];
    if (opts.collectivePath && existsSync(opts.collectivePath)) {
      const cfg = CollectiveConfig.parse(JSON.parse(readFileSync(opts.collectivePath, "utf8")));
      const dir = dirname(resolve(opts.collectivePath));
      if (cfg.desks) world.town.setDesks(cfg.desks);
      for (const spec of cfg.buildings) {
        let b: Building;
        if (spec.import) {
          b = world.importV0(resolve(dir, spec.import), { creatorUserId: admin.id }).building;
        } else {
          const id = spec.id ?? (spec.name ?? "building").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
          b = createBuilding(world, {
            name: spec.name ?? id, goal: spec.goal ?? "", description: spec.description ?? "", headcount: spec.headcount ?? Math.max(spec.residents.length + 1, 3),
            reviewPolicy: spec.reviewPolicy ?? "human", model: spec.model, cheapModel: spec.cheapModel, maxTurnsPerSession: spec.maxTurnsPerSession,
            dailyTokensPerAgent: spec.dailyTokensPerAgent, meetings: spec.meetings,
            workspace: spec.workspace ? withRepoUrl({ ...spec.workspace, path: resolve(dir, spec.workspace.path) }) : undefined,
          }, admin.id, { id });
          spec.residents.forEach((r, i) => createResident(world, { buildingId: b.id, name: r.name, title: r.title, direction: r.direction, sprite: r.sprite ?? (i + 1) % 7, model: r.model }));
        }
        if (spec.reviewer) {
          const rev = createResident(world, {
            buildingId: b.id, name: spec.reviewer.name, title: "Reviewer", sprite: spec.reviewer.sprite ?? 7,
            direction: spec.reviewer.direction ?? REVIEWER_DIRECTION,
          });
          world.permissions.grant(rev, buildingRoleId(b.id, "reviewer"));
          if (!moss) moss = rev;
        }
        if (spec.houseTokens) world.budget.donate(admin.id, { tokens: spec.houseTokens, buildingId: b.id });
        if (!lab) lab = b;
      }
      for (const m of cfg.moderators) moderators.push(createTownModerator(world, m));
    }
    world.events.append({ type: "system", text: "Town seeded", payload: { adminId: admin.id, labId: lab?.id ?? null } });
    return { created: true, admin: world.users.require(admin.id), adminToken, townHall: world.buildings.require(townHall.id), ada, lab, moss, moderators };
  });
  if (opts.dataDir) {
    mkdirSync(opts.dataDir, { recursive: true });
    writeFileSync(join(opts.dataDir, "admin-token"), result.adminToken + "\n", { mode: 0o600 });
  }
  return result;
}
