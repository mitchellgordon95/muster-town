import {
  Agent, CreateBuildingInput, CreateResidentInput, RegisterVisitorInput,
  type Building, type Lot, type Tile, type User,
} from "@muster-town/schema";
import { AppError, badRequest } from "./errors.ts";
import { buildingRoleId, townRoleId } from "./permissions.ts";
import { suggestResidentName } from "./names.ts";
import { newId, nowIso } from "./util.ts";
import type { Furniture } from "./world/furniture.ts";
import { MAX_HEADCOUNT, TOWN_HALL_ID } from "./world/layout.ts";
import { nearestWalkable } from "./world/path.ts";
import type { World } from "./world.ts";

type In<T extends { _input: unknown }> = T["_input"];

export function createUser(world: World, name: string, opts: { id?: string } = {}): { user: User; token: string } {
  const user = world.users.upsert({ id: opts.id ?? newId("us"), name, createdAt: nowIso(), donatedTokens: 0, hasApiKey: false });
  return { user, token: world.tokens.create("user", user.id) };
}

/**
 * Create a building: built-in building roles (manager/reviewer/member), creator gets `manager`,
 * lot assigned, `building.created` event. It gets code access to the collective repo when the town has one, unless told otherwise.
 */
export function createBuilding(
  world: World,
  input: In<typeof CreateBuildingInput>,
  creatorUserId: string | null,
  opts: { id?: string; kind?: Building["kind"]; lot?: Lot; starterResidents?: boolean } = {},
): Building {
  const inp = CreateBuildingInput.parse(input);
  if (inp.managerAgentId) throw badRequest("A new building has no residents yet; set its manager after they join.");
  if ((inp.headcount ?? 6) > MAX_HEADCOUNT) throw badRequest(`headcount must be <= ${MAX_HEADCOUNT}`);
  const id = opts.id ?? newId("bl");
  if (world.buildings.get(id)) throw new AppError("conflict", `Building ${id} already exists.`);
  if (creatorUserId) world.users.require(creatorUserId, "user");
  return world.transaction(() => {
    const building = world.buildings.upsert({
      ...inp, codeAccess: inp.codeAccess ?? (opts.kind !== "town-hall" && !!world.town.get().workspace), id, kind: opts.kind ?? "lab", createdAt: nowIso(), createdBy: creatorUserId ?? undefined, ...(opts.lot ? { lot: opts.lot } : {}),
      // new buildings are goal-directed (schema default) with the default exploration allowance; the Town Hall has no grants, so it stays open
      ...(opts.kind === "town-hall" ? { budgetMode: "open" as const } : {}),
    } as Building);
    world.permissions.ensureTownRoles();
    world.permissions.ensureBuildingRoles(id);
    if (creatorUserId) world.permissions.grant({ kind: "user", id: creatorUserId }, buildingRoleId(id, "manager"));
    world.layout.rebuild();
    world.events.append({ type: "building.created", buildingId: id, text: `${building.name} was built`, payload: { createdBy: creatorUserId } });
    if (opts.starterResidents && building.kind === "lab") seedStarterResidents(world, id);
    return world.buildings.require(id);
  });
}

/** Residents a building made from the UI/API starts with: the first is its manager, the rest are workers. */
export const STARTER_RESIDENTS = 3;

/** Move in up to STARTER_RESIDENTS residents with town-picked names (capped by headcount); the first becomes manager. */
function seedStarterResidents(world: World, buildingId: string): void {
  const n = Math.min(STARTER_RESIDENTS, world.buildings.require(buildingId).headcount);
  const residents = Array.from({ length: n }, () => createResident(world, { buildingId }));
  if (residents[0]) world.buildings.upsert({ ...world.buildings.require(buildingId), managerAgentId: residents[0].id });
  syncManagerRoles(world);
}

/**
 * A building's `managerAgentId` (the meeting facilitator) holds that building's `manager` role too, so naming a manager
 * also grants the permissions (assign, review, ...). Grant-only and idempotent: a previous manager keeps a role that was given by hand.
 */
export function syncManagerRoles(world: World): void {
  for (const b of world.buildings.all()) {
    const m = b.managerAgentId && world.agents.get(b.managerAgentId);
    const roleId = buildingRoleId(b.id, "manager");
    if (m && world.permissions.agentsWithRole(roleId).indexOf(m.id) < 0 && world.permissions.rolesForBuilding(b.id).some((r) => r.id === roleId)) world.permissions.grant(m, roleId);
  }
}

/** Update building settings (validated); re-lots if headcount grew. */
export function updateBuilding(world: World, id: string, patch: Partial<In<typeof CreateBuildingInput>>): Building {
  const cur = world.buildings.require(id, "building");
  const p = CreateBuildingInput.partial().parse(patch);
  if (p.headcount !== undefined) {
    if (p.headcount > MAX_HEADCOUNT) throw badRequest(`headcount must be <= ${MAX_HEADCOUNT}`);
    const used = world.layout.deskCount(id);
    if (p.headcount < used) throw badRequest(`headcount ${p.headcount} is below the ${used} occupied desks`);
  }
  if (p.managerAgentId) {
    const a = world.agents.get(p.managerAgentId);
    if (!a || a.kind !== "resident" || a.homeBuildingId !== id || a.forkOf) throw badRequest("The manager must be a (named) resident of this building.");
    if (a.status === "stopped" || a.status === "banned" || a.status === "retired") throw badRequest(`Can't make ${a.name} manager: they are ${a.status}.`);
  }
  const clean = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
  const updated = world.buildings.upsert({ ...cur, ...clean });
  syncManagerRoles(world);
  world.layout.rebuild();
  world.events.append({ type: "building.updated", buildingId: id, text: `${updated.name} settings updated`, payload: { fields: Object.keys(clean) } });
  return world.buildings.require(id);
}

/**
 * Save a building's furniture (lot-relative anchors; pieces left out stay put). Throws on an illegal room.
 * Bodies follow: anyone at a place or meeting seat that moved goes to its new tile, anyone on a now-blocked
 * tile steps to the nearest free one, and walks are re-planned. Place ids don't change.
 */
export function updateFurniture(world: World, id: string, furniture: Furniture, by: string | null): Building {
  const b = world.buildings.require(id, "building");
  const map = world.layout;
  const preview = map.preview(id, furniture);
  if (preview.errors.length) throw badRequest(preview.errors.map((e) => e.message).join(" "));
  const before = bodiesBefore(world);
  return world.transaction(() => {
    world.buildings.upsert({ ...b, furniture: preview.furniture });
    map.rebuild();
    followBodies(world, before, (pos) => (map.buildingAt(pos)?.id === id ? pos : null));
    world.events.append({ type: "building.layout", buildingId: id, text: `${b.name} layout changed`, payload: { by, before: b.furniture, after: preview.furniture } });
    return world.buildings.require(id);
  });
}

/** Where every place and meeting seat is now, so bodies can follow a layout change. */
function bodiesBefore(world: World) {
  const map = world.layout;
  return { places: new Map(map.places.map((p) => [p.id, p.pos])), seats: new Map(map.places.map((p) => [p.id, map.seatsOf(p.id)])) };
}

/**
 * After a rebuild: anyone at a place or meeting seat that moved goes to its new tile; anyone else `pick` returns a
 * tile for (null = leave alone) steps to the nearest free tile from there. Walks are re-planned. Place ids don't change.
 */
function followBodies(world: World, before: ReturnType<typeof bodiesBefore>, pick: (pos: Tile) => Tile | null) {
  const map = world.layout;
  const moves = new Map<string, Tile>();
  for (const p of map.places) {
    const old = before.places.get(p.id);
    if (old && (old.x !== p.pos.x || old.y !== p.pos.y)) moves.set(`${old.x},${old.y}`, p.pos);
    const now = map.seatsOf(p.id);
    (before.seats.get(p.id) ?? []).forEach((s, i) => { if (now[i] && !moves.has(`${s.x},${s.y}`)) moves.set(`${s.x},${s.y}`, now[i]); });
  }
  const moved = (t: Tile) => moves.get(`${t.x},${t.y}`) ?? t;
  const positions: { id: string; x: number; y: number; status: Agent["status"] }[] = [];
  for (const a of world.agents.where("status != 'retired'")) {
    if (world.movement.isWalking(a.id)) continue;
    const to = moves.get(`${a.pos.x},${a.pos.y}`) ?? pick(a.pos);
    if (!to) continue;
    const pos = nearestWalkable(map.grid, to);
    if (pos.x === a.pos.x && pos.y === a.pos.y) continue;
    world.agents.upsert({ ...a, pos }, { silent: true });
    positions.push({ id: a.id, x: pos.x, y: pos.y, status: a.status });
  }
  world.movement.reroute(moved);
  if (positions.length) world.changes.emit({ type: "agents.pos", positions });
}

/**
 * Town planning: move/resize buildings (`lots`, left out = stays put) and optionally build one new building on a
 * drawn lot, in one step. Throws on an illegal plan. Bodies inside a moved building move with it; anyone a
 * building now stands on steps to the nearest free tile.
 */
export function planTown(world: World, lots: Record<string, Lot>, create: (In<typeof CreateBuildingInput> & { lot: Lot }) | undefined, creatorUserId: string | null): { buildings: Building[]; created: Building | null } {
  const map = world.layout;
  const preview = map.planPreview(lots, create && { name: create.name, headcount: create.headcount, lot: create.lot });
  if (preview.errors.length) throw badRequest(preview.errors.map((e) => e.message).join(" "));
  const changed = Object.entries(lots).map(([id, lot]) => ({ old: world.buildings.require(id, "building"), lot }))
    .filter(({ old, lot }) => !old.lot || old.lot.x !== lot.x || old.lot.y !== lot.y || old.lot.w !== lot.w || old.lot.h !== lot.h);
  if (!changed.length && !create) return { buildings: [], created: null };
  const before = bodiesBefore(world);
  return world.transaction(() => {
    for (const { old, lot } of changed) world.buildings.upsert({ ...old, lot });
    map.rebuild();
    const inOld = (pos: Tile) => changed.find(({ old: { lot: l } }) => l && pos.x >= l.x && pos.x < l.x + l.w && pos.y >= l.y && pos.y < l.y + l.h);
    followBodies(world, before, (pos) => {
      const c = inOld(pos);
      if (c) return { x: pos.x + c.lot.x - c.old.lot!.x, y: pos.y + c.lot.y - c.old.lot!.y };
      return map.isWalkable(pos.x, pos.y) ? null : pos;
    });
    for (const { old, lot } of changed) {
      world.events.append({ type: "town.plan", buildingId: old.id, text: `${old.name} was ${old.lot && (old.lot.w !== lot.w || old.lot.h !== lot.h) ? "resized" : "moved"}`, payload: { by: creatorUserId, before: old.lot ?? null, after: lot } });
    }
    let created: Building | null = null;
    if (create) {
      const { lot, ...input } = create;
      created = createBuilding(world, input, creatorUserId, { lot, starterResidents: true });
      followBodies(world, bodiesBefore(world), (pos) => (map.isWalkable(pos.x, pos.y) ? null : pos));
    }
    return { buildings: changed.map(({ old }) => world.buildings.require(old.id)), created };
  });
}

/** Create a resident at the building's lowest free desk (a full lab grows by one); it gets `member` in that building. */
export function createResident(world: World, input: In<typeof CreateResidentInput>): Agent {
  const inp = CreateResidentInput.parse(input);
  const b = world.buildings.require(inp.buildingId, "building");
  if (b.kind !== "lab") throw badRequest("Residents live in labs.");
  return world.transaction(() => {
    const id = newId("ag");
    const existing = world.agents.where("homeBuildingId = ? AND kind = 'resident' AND forkOf IS NULL", [b.id]).length;
    // insert first (desk names come from the agents table), then claim the desk and move the body there
    world.agents.upsert(Agent.parse({
      id, name: inp.name || suggestResidentName(world), kind: "resident", buildingId: b.id, homeBuildingId: b.id, ownerUserId: b.createdBy ?? null,
      title: inp.title, direction: inp.direction, sprite: inp.sprite ?? (existing % 8) + 1, model: inp.model ?? null,
      pos: world.layout.door(b.id) ?? { x: 0, y: 0 }, status: "idle", createdAt: nowIso(),
    }), { silent: true });
    // a full lab grows by a desk (and re-lots if it no longer fits); bodies at places follow a moved lot
    const before = bodiesBefore(world);
    const desk = world.layout.claimDesk(b.id, id, { grow: true });
    followBodies(world, before, () => null);
    const agent = world.agents.patch(id, { pos: desk.pos });
    world.permissions.grant(agent, buildingRoleId(b.id, "member"));
    world.events.append({ type: "agent.created", agentId: id, buildingId: b.id, text: `${agent.name} joined ${b.name}`, payload: { kind: "resident" } });
    return agent;
  });
}

/** A town moderator: a Town Hall resident holding the town `moderator` role, seated at the mod station. */
export function createTownModerator(world: World, input: { name: string; sprite?: number; direction?: string; model?: string }): Agent {
  const th = world.buildings.require(TOWN_HALL_ID, "building");
  return world.transaction(() => {
    const id = newId("ag");
    world.agents.upsert(Agent.parse({
      id, name: input.name, kind: "resident", buildingId: th.id, homeBuildingId: th.id, ownerUserId: th.createdBy ?? null,
      title: "Moderator", sprite: input.sprite ?? 6, model: input.model ?? null,
      direction: input.direction ?? "Collective-wide misuse prevention: delete outbox requests that misuse the town, review trophy proposals, and ban agents that misuse the town. Every building keeps its own policies; you don't review research.",
      pos: world.layout.door(th.id) ?? { x: 0, y: 0 }, status: "idle", createdAt: nowIso(),
    }), { silent: true });
    const desk = world.layout.claimDesk(th.id, id);
    const agent = world.agents.patch(id, { pos: desk.pos });
    world.permissions.ensureTownRoles();
    world.permissions.grant(agent, townRoleId("moderator"));
    world.events.append({ type: "agent.created", agentId: id, buildingId: th.id, text: `${agent.name} (town moderator) took a seat at the mod station`, payload: { kind: "resident", townModerator: true } });
    return agent;
  });
}

function spawnPoint(world: World, buildingId?: string | null): Tile {
  const p = (buildingId && world.layout.door(buildingId)) || world.layout.place("plaza")?.pos;
  return p ? { ...p } : { x: 1, y: world.layout.grid.h - 3 };
}

/** The nearest walkable tile to `p` (within 3 tiles) no live body stands on, so two newcomers don't arrive stacked; `p` when all are taken. */
function freeTileNear(world: World, p: Tile): Tile {
  const taken = new Set(world.agents.where("status NOT IN ('retired','banned')").map((o) => `${o.pos.x},${o.pos.y}`));
  for (let r = 0; r <= 3; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = p.x + dx, y = p.y + dy;
      if (world.layout.isWalkable(x, y) && !taken.has(`${x},${y}`)) return { x, y };
    }
  }
  return { ...p };
}

/**
 * A user's visitor agent (Claude Code over MCP or the CLI). Returns the agent and its token. With `buildingId` it
 * claims a free desk there like a resident (`homeBuildingId` set; no free desk → it waits at the Town Hall visitor
 * bench, still homed in the building); without one it sits at the visitor bench.
 */
export function registerVisitor(world: World, userId: string, input: In<typeof RegisterVisitorInput>): { agent: Agent; token: string } {
  const inp = RegisterVisitorInput.parse(input);
  world.users.require(userId, "user");
  const b = inp.buildingId ? world.buildings.require(inp.buildingId, "building") : null;
  return world.transaction(() => {
    const id = newId("ag");
    // insert first (desk names come from the agents table), then claim the desk and move the body there
    world.agents.upsert(Agent.parse({
      id, name: inp.name, kind: "visitor", buildingId: b?.id ?? null, homeBuildingId: b?.id ?? null,
      ownerUserId: userId, title: inp.title ?? "Visitor", sprite: 6, pos: spawnPoint(world, b?.id), createdAt: nowIso(),
      inheritsOwner: inp.inheritsOwner ?? true,
    }), { silent: true });
    let desk: ReturnType<typeof world.layout.claimDesk> | null = null;
    if (b) {
      try { desk = world.layout.claimDesk(b.id, id); } catch (e) { if (!(e instanceof AppError) || e.code !== "conflict") throw e; }
    }
    const pos = desk ? desk.pos : world.presence.benchSeat(id);
    const agent = world.agents.patch(id, { pos, buildingId: world.layout.buildingAt(pos)?.id ?? null });
    world.permissions.ensureTownRoles();
    world.permissions.grant(agent, townRoleId("visitor"));
    // v1.5: the agent is capped by its owner, so the owner holds the visitor baseline too (GitHub sign-in already grants it)
    world.permissions.grant({ kind: "user", id: userId }, townRoleId("visitor"));
    const where = desk ? `took a desk in ${b!.name}` : "is at the visitor bench";
    world.events.append({ type: "agent.created", agentId: agent.id, buildingId: agent.homeBuildingId ?? agent.buildingId, text: `${agent.name} arrived as a visitor and ${where}`, payload: { kind: "visitor", ownerUserId: userId, desk: !!desk } });
    return { agent, token: world.tokens.create("agent", agent.id) };
  });
}

/** The user's human avatar (kind `human`), created at the plaza on first call. */
export function ensureAvatar(world: World, userId: string): Agent {
  const existing = world.agents.first("kind = 'human' AND ownerUserId = ?", [userId]);
  if (existing) return existing;
  const user = world.users.require(userId, "user");
  const agent = world.agents.upsert(Agent.parse({
    id: newId("ag"), name: user.name, kind: "human", ownerUserId: userId, title: "Human", sprite: 0, inheritsOwner: true,
    pos: freeTileNear(world, spawnPoint(world)), createdAt: nowIso(),
  }));
  world.events.append({ type: "agent.created", agentId: agent.id, text: `${user.name} walked into town`, payload: { kind: "human", userId } });
  return agent;
}

/** Ada-style service agent standing next to a place. */
export function createServiceAgent(world: World, input: { name: string; title: string; placeId: string; sprite?: number; id?: string }): Agent {
  const place = world.layout.requirePlace(input.placeId);
  const pos = world.layout.isWalkable(place.pos.x + 1, place.pos.y) ? { x: place.pos.x + 1, y: place.pos.y } : place.pos;
  const agent = world.agents.upsert(Agent.parse({
    id: input.id ?? newId("ag"), name: input.name, kind: "service", buildingId: place.buildingId, homeBuildingId: place.buildingId ?? TOWN_HALL_ID,
    title: input.title, sprite: input.sprite ?? 0, pos, createdAt: nowIso(),
  }));
  world.events.append({ type: "agent.created", agentId: agent.id, buildingId: agent.buildingId, text: `${agent.name} (${agent.title}) is at the ${place.name}`, payload: { kind: "service" } });
  return agent;
}
