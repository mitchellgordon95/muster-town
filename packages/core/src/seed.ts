import { CollectiveConfig, Town, type Doc, townEnv, type Agent, type Building, DesksConfig, type User, type Workspace } from "@muster-town/schema";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createDoc, updateDoc } from "./domain.ts";
import { createBuilding, createResident, createServiceAgent, createTownModerator, createUser } from "./entities.ts";
import { buildingRoleId, townRoleId } from "./permissions.ts";
import { TOWN_HALL_ID } from "./world/layout.ts";
import type { World } from "./world.ts";

export const HOUSE_BUDGET_TOKENS = 1_700_000;
/** The seed's house allocation is a placeholder until the owner enters real funding (see budget.retirePlaceholders). */
export const HOUSE_LABEL = "House budget (placeholder)";

export interface SeedOptions {
  /** admin display name (default env MUSTER_TOWN_ADMIN_NAME or "Mitchell") */
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
  /** the humans' operating manual (docs/manual.md): seeded as a Town Hall library article tagged `manual` when none exists */
  manualPath?: string;
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

/** collective.json's `workspace`, its path resolved from the collective dir. */
function collectiveWorkspace(collectivePath: string | undefined): Workspace | undefined {
  if (!collectivePath || !existsSync(collectivePath)) return undefined;
  const cfg = CollectiveConfig.parse(JSON.parse(readFileSync(collectivePath, "utf8")));
  return cfg.workspace ? { ...cfg.workspace, path: resolve(dirname(resolve(collectivePath)), cfg.workspace.path) } : undefined;
}

export const MANUAL_TAG = "manual";

/** The humans' operating manual: the newest non-draft doc tagged `manual` (the HUD "?" opens it). */
export function findManual(world: World): Doc | null {
  return world.docs.first(`state != 'draft' AND EXISTS (SELECT 1 FROM json_each(docs.tags) WHERE value = ?)`, [MANUAL_TAG], "ORDER BY updatedAt DESC, rowid DESC") ?? null;
}

/**
 * sha256 of every earlier repo edition's body (docs/manual.md minus its h1). A live manual whose body still equals one
 * of them was never edited in town, so a newer repo edition replaces it on boot. Add the outgoing edition's hash here
 * whenever docs/manual.md changes.
 */
export const PAST_MANUAL_EDITIONS = [
  "f651db524065aa2274cfd393bf04aee988b47ace14a5efd6c05a543ebf78dd13", // edition 1 (bb7c00f)
  "faab34e2dba030eeb96555126d1e8b66a4c0bec3423fadbddad4b634ebdad207", // edition 2 (8a7a7ca)
  "322c0e934c1fd220b32a63cc3af86e75619eee160d6e70bcc48c291cfac39886", // edition 3 (00a6223)
  "7ecbbe7e59578305c428bf0d20a3343e4e84a859ee40aea2ec8e62c1565b88d4", // edition 3.1 (c68edcf)
  "7699c98dde9692834f7d9a57e436bccfb77051f5d363faa5e1e8219da028ea29", // edition 3.2 (a2091b9)
  "77d4684ab7e1f1543c155ec41fac97dca585c5ae93b879d3a4c9aff0fbeb3e38", // edition 3.3 (522c527)
  "3a539011337b3187dca63d4c08282acea0a383b9651c6f41775abee8fe8cca13", // edition 3.4 (c3b6e98)
];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * The repo's copy of the manual becomes a Town Hall library article only when the town has none: once it exists the
 * world doc is the source of truth (edited live, never overwritten from the file). The one exception: a doc that
 * still holds an earlier repo edition word for word (PAST_MANUAL_EDITIONS) is updated to the file's edition.
 */
export function seedManual(world: World, path: string | undefined, authorId: string): Doc | null {
  if (!path || !existsSync(path)) return null;
  const body = readFileSync(path, "utf8").replace(/^# [^\n]*\n+/, "");
  const live = findManual(world);
  if (live) return live.body !== body && PAST_MANUAL_EDITIONS.includes(sha256(live.body)) ? updateDoc(world, live.id, { body }) : null;
  const th = world.buildings.get(TOWN_HALL_ID) ?? world.buildings.first("kind = 'town-hall'");
  return createDoc(world, {
    type: "article", state: "library", title: "Operating manual", body, tags: [MANUAL_TAG],
    authorId, authorKind: "user", buildingId: th?.id ?? null,
  }, "The operating manual was placed in the library");
}

/**
 * Seed an empty town: town.json, admin user + token, built-in roles, Town Hall with Ada (service
 * librarian at the library), optional v0 lab import + Moss (reviewer) + house allocation; admin manages the lab;
 * collective.json buildings and town moderators (seated at the mod station).
 * Re-running on a seeded DB returns the existing admin/token and creates no agents (it sets the collective repo
 * from collective.json if the town has none, backfills its repoUrl
 * and makes sure the built-in town roles, including v1.2's `moderator`, exist).
 */
export function seedDefaults(world: World, opts: SeedOptions = {}): SeedResult {
  const existing = world.users.first("1=1", [], "ORDER BY createdAt, rowid");
  if (existing) {
    // the collective repo: from collective.json when the town has none yet; backfill repoUrl seeded before desks existed
    const town = world.town.get();
    const ws = town.workspace ?? collectiveWorkspace(opts.collectivePath);
    if (ws) {
      const filled = withRepoUrl(ws);
      if (filled !== town.workspace) world.town.set({ workspace: filled });
    }
    // the town's copy (name, goal, tagline, goalNote) spelled in town.json wins on every boot: nothing edits it live,
    // so the file is where it changes (KR 2: the tagline says what the place is in plain words)
    if (opts.townJsonPath && existsSync(opts.townJsonPath)) {
      const raw = JSON.parse(readFileSync(opts.townJsonPath, "utf8")) as Record<string, unknown>;
      const copy = Town.partial().parse({ name: raw.name, goal: raw.goal, tagline: raw.tagline, goalNote: raw.goalNote });
      const changed = Object.fromEntries(Object.entries(copy).filter(([k, v]) => v !== undefined && v !== town[k as keyof Town]));
      if (Object.keys(changed).length) world.town.set(changed);
    }
    // the keys collective.json spells out under `desks` win on every boot; the ones it leaves out (e.g. a `maxRunning` set live
    // via PUT /api/town/desks) keep their stored value. Without this, backend/snapshot/townUrl could never change after the seed.
    if (opts.collectivePath && existsSync(opts.collectivePath)) {
      const spelled = (JSON.parse(readFileSync(opts.collectivePath, "utf8")) as { desks?: Partial<DesksConfig> }).desks;
      if (spelled && Object.keys(spelled).length) world.town.setDesks({ ...world.town.desks(), ...DesksConfig.partial().parse(spelled) });
    }
    // v1.2: the town moderator role (no moderator agents are created in existing DBs)
    world.permissions.ensureTownRoles();
    const th = world.buildings.get(TOWN_HALL_ID) ?? world.buildings.first("kind = 'town-hall'")!;
    seedManual(world, opts.manualPath, existing.id);
    const lab = world.buildings.first("kind = 'lab'", [], "ORDER BY createdAt") ?? null;
    return {
      created: false, admin: existing, adminToken: world.tokens.getOrCreate("user", existing.id), townHall: th,
      ada: world.agents.first("kind = 'service'") ?? null, lab,
      moss: lab ? reviewerOf(world, lab.id) : null, moderators: [],
    };
  }
  const result = world.transaction(() => {
    let town: Partial<Town> = { name: "Muster Town", goal: "", tagline: "publicly legible, collectively funded agent town for climate science" };
    if (opts.townJsonPath && existsSync(opts.townJsonPath)) {
      const raw = JSON.parse(readFileSync(opts.townJsonPath, "utf8")) as Record<string, unknown>;
      town = { ...town, ...Town.partial().parse({ name: raw.name, goal: raw.goal, tagline: raw.tagline, goalNote: raw.goalNote }) };
    }
    world.town.set(town);
    world.permissions.ensureTownRoles();
    const { user: admin, token: adminToken } = createUser(world, opts.adminName ?? townEnv("ADMIN_NAME") ?? "Mitchell");
    world.permissions.grant({ kind: "user", id: admin.id }, townRoleId("admin"));

    const townHall = createBuilding(world, {
      name: "Town Hall", goal: world.town.get().goal, description: "Library, trophy room, outbox, and the town meeting room.", headcount: 1,
    }, admin.id, { id: TOWN_HALL_ID, kind: "town-hall" });
    const ada = createServiceAgent(world, { name: "Ada", title: "Librarian", placeId: "library", sprite: 0 });

    let lab: Building | null = null, moss: Agent | null = null;
    if (opts.importDir && existsSync(join(opts.importDir, "building.json"))) {
      lab = world.importV0(opts.importDir, { creatorUserId: admin.id }).building;
      moss = createResident(world, { buildingId: lab.id, name: "Moss", title: "Reviewer", sprite: 7, direction: REVIEWER_DIRECTION });
      world.permissions.grant(moss, buildingRoleId(lab.id, "reviewer"));
      world.budget.donate(admin.id, { tokens: opts.houseTokens ?? HOUSE_BUDGET_TOKENS, buildingId: lab.id, label: HOUSE_LABEL });
    }
    const moderators: Agent[] = [];
    if (opts.collectivePath && existsSync(opts.collectivePath)) {
      const rawCfg = JSON.parse(readFileSync(opts.collectivePath, "utf8")) as { desks?: Partial<DesksConfig> };
      const cfg = CollectiveConfig.parse(rawCfg);
      const dir = dirname(resolve(opts.collectivePath));
      // the keys collective.json spells out win; the ones it leaves out (e.g. a `maxRunning` set live via PUT /api/town/desks) survive restarts
      if (cfg.desks) world.town.setDesks({ ...(world.town.isSet() ? world.town.desks() : {}), ...rawCfg.desks });
      const ws = collectiveWorkspace(opts.collectivePath);
      if (ws) world.town.set({ workspace: withRepoUrl(ws) });
      for (const spec of cfg.buildings) {
        let b: Building;
        if (spec.import) {
          b = world.importV0(resolve(dir, spec.import), { creatorUserId: admin.id }).building;
        } else {
          const id = spec.id ?? (spec.name ?? "building").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
          b = createBuilding(world, {
            name: spec.name ?? id, goal: spec.goal ?? "", description: spec.description ?? "", headcount: spec.headcount ?? Math.max(spec.residents.length + 1, 3),
            model: spec.model, cheapModel: spec.cheapModel, maxTurnsPerSession: spec.maxTurnsPerSession,
            dailyTokensPerAgent: spec.dailyTokensPerAgent, meetings: spec.meetings,
            codeAccess: spec.codeAccess, forks: spec.forks,
          }, admin.id, { id });
          spec.residents.forEach((r, i) => {
            const a = createResident(world, { buildingId: b.id, name: r.name, title: r.title, direction: r.direction, sprite: r.sprite ?? (i + 1) % 7, model: r.model });
            for (const role of r.townRoles ?? []) world.permissions.grant(a, `role:${role}`);
          });
        }
        if (spec.reviewer) {
          const rev = createResident(world, {
            buildingId: b.id, name: spec.reviewer.name, title: "Reviewer", sprite: spec.reviewer.sprite ?? 7,
            direction: spec.reviewer.direction ?? REVIEWER_DIRECTION,
          });
          world.permissions.grant(rev, buildingRoleId(b.id, "reviewer"));
          if (!moss) moss = rev;
        }
        if (spec.houseTokens) world.budget.donate(admin.id, { tokens: spec.houseTokens, buildingId: b.id, label: HOUSE_LABEL });
        if (!lab) lab = b;
      }
      for (const m of cfg.moderators) moderators.push(createTownModerator(world, m));
    }
    world.events.append({ type: "system", text: "Town seeded", payload: { adminId: admin.id, labId: lab?.id ?? null } });
    return { created: true, admin: world.users.require(admin.id), adminToken, townHall: world.buildings.require(townHall.id), ada, lab, moss, moderators };
  });
  seedManual(world, opts.manualPath, result.admin.id);
  if (opts.dataDir) {
    mkdirSync(opts.dataDir, { recursive: true });
    const file = join(opts.dataDir, "admin-token");
    writeFileSync(file, result.adminToken + "\n", { mode: 0o600 });
    chmodSync(file, 0o600); // `mode` only applies when the file is created

  }
  return result;
}
