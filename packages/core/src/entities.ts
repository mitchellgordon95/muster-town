import { isGone, NOT_GONE,
  Agent, CreateBuildingInput, patchOf, ROOT_GOAL_ID, CreateResidentInput, RegisterVisitorInput,
  type Building, type BuildingDefaults, type Lot, type Tile, type User,
} from "@muster-town/schema";
import { AppError, badRequest, notFound } from "./errors.ts";
import { buildingRoleId, townRoleId } from "./permissions.ts";
import { suggestResidentName } from "./names.ts";
import { newId, nowIso } from "./util.ts";
import type { Furniture } from "./world/furniture.ts";
import type { Before, Moved } from "./world/map.ts";
import { MAX_HEADCOUNT } from "./world/layout.ts";
import { nearestWalkable } from "./world/path.ts";
import type { Actor } from "./ops.ts";
import type { World } from "./world.ts";

type In<T extends { _input: unknown }> = T["_input"];

export function createUser(world: World, name: string, opts: { id?: string } = {}): { user: User; token: string } {
  const user = world.users.upsert({ id: opts.id ?? newId("us"), name, createdAt: nowIso(), donatedTokens: 0, hasApiKey: false });
  return { user, token: world.tokens.create("user", user.id) };
}

/**
 * Create a building: built-in building roles (manager/member), creator gets `manager`,
 * lot assigned, `building.created` event. It copies the collective defaults (model, cheap model, max turns, daily budget,
 * code access: `TownMeta.defaults()`).
 */
export function createBuilding(
  world: World,
  input: In<typeof CreateBuildingInput> & SpecText,
  creatorUserId: string | null,
  opts: { id?: string; kind?: Building["kind"]; lot?: Lot; starterResidents?: boolean; manager?: ManagerSpec } = {},
): Building {
  const inp = CreateBuildingInput.parse(input);
  // goal/description text only from old specs (seed, import-v0); the API and UI set the attachment instead
  const text = { goal: input.goal ?? "", description: input.description ?? "" };
  // model, cheap model, max turns, daily budget and code access are the collective's defaults (PUT /api/town/defaults);
  // an old spec's per-building value still wins at seed, and the Town Hall never gets code access
  const own = Object.fromEntries(DEFAULT_KEYS.flatMap((k) => input[k] === undefined ? [] : [[k, input[k]]]));
  const defaults: BuildingDefaults = { ...world.town.defaults(), ...own, ...(opts.kind === "town-hall" ? { codeAccess: false } : {}) };
  if (inp.managerAgentId) throw badRequest("A new building has no residents yet; set its manager after they join.");
  if ((inp.headcount ?? 6) > MAX_HEADCOUNT) throw badRequest(`headcount must be <= ${MAX_HEADCOUNT}`);
  const id = opts.id ?? newId("bl");
  if (world.buildings.get(id)) throw new AppError("conflict", `Building ${id} already exists.`);
  if (creatorUserId) world.users.require(creatorUserId, "user");
  // attached to one goal of the town tree from the start (docs/goals.md; default: the root)
  const goalId = inp.goalId ?? ROOT_GOAL_ID;
  const goal = world.goals.get(goalId);
  if (!goal || goal.status !== "active") throw badRequest(`${goalId} is not an active goal of the town tree.`);
  if (opts.kind !== "town-hall") world.goalTree.requireDesksFit(null, goalId, inp.headcount ?? 6);
  return world.transaction(() => {
    const building = world.buildings.upsert({
      ...inp, ...text, ...defaults, name: inp.name || world.goalTree.defaultName(goalId), goalId, id, kind: opts.kind ?? "lab", createdAt: nowIso(), createdBy: creatorUserId ?? undefined, ...(opts.lot ? { lot: opts.lot } : {}),
    } as Building);
    world.permissions.ensureTownRoles();
    world.permissions.ensureBuildingRoles(id);
    if (creatorUserId) world.permissions.grant({ kind: "user", id: creatorUserId }, buildingRoleId(id, "manager"));
    world.layout.rebuild();
    world.events.append({ type: "building.created", buildingId: id, text: `${building.name} was built`, payload: { createdBy: creatorUserId } });
    if ((opts.starterResidents || opts.manager) && building.kind === "lab") seedManager(world, id, opts.manager);
    return world.buildings.require(id);
  });
}

/** A seeded manager's name, sprite and model (collective.json `manager`); left out = town-named, on the starter model. */
type ManagerSpec = { name?: string; sprite?: number; model?: string };

/**
 * The model every new resident runs its own sessions on: building managers (flag dc_knetp3kqnu), the Town Hall Planner
 * and Secretary, any resident made later (1:1 mt_i50xwu4z2t). Its forks do not inherit it: a fork takes its
 * assignment's model or the building's (forks.ts), Opus by default.
 */
export const STARTER_MANAGER_MODEL = "claude-fable-5-1";

/**
 * A building made from the UI/API moves in its one named manager, town-named, on Fable, at a desk (1:1 mt_wngibcr98b
 * decision 1: no standing residents; its queued work runs on forks of the manager).
 */
export function seedManager(world: World, buildingId: string, spec: ManagerSpec = {}): Agent {
  const manager = createResident(world, { buildingId, name: spec.name, sprite: spec.sprite, model: spec.model ?? STARTER_MANAGER_MODEL });
  world.buildings.upsert({ ...world.buildings.require(buildingId), managerAgentId: manager.id });
  syncManagerRoles(world);
  return world.agents.require(manager.id);
}

/**
 * A building's `managerAgentId` (the meeting facilitator) holds that building's `manager` role too, so naming a manager
 * also grants the permissions (assign, review, ...). Grant-only and idempotent: a previous manager keeps a role that was given by hand.
 * Not the Town Hall's (the Planner): it reviews nothing there.
 */
export function syncManagerRoles(world: World): void {
  for (const b of world.buildings.all()) {
    if (b.kind === "town-hall") continue;
    const m = b.managerAgentId && world.agents.get(b.managerAgentId);
    const roleId = buildingRoleId(b.id, "manager");
    if (m && world.permissions.agentsWithRole(roleId).indexOf(m.id) < 0 && world.permissions.rolesForBuilding(b.id).some((r) => r.id === roleId)) world.permissions.grant(m, roleId);
  }
}

const DEFAULT_KEYS = ["model", "cheapModel", "maxTurnsPerSession", "dailyTokensPerAgent", "codeAccess"] as const;
/** What only old specs (collective.json buildings, import-v0) still set per building, not part of the API: goal/description text and the collective defaults' fields. */
type SpecText = { goal?: string; description?: string } & Partial<BuildingDefaults>;

/**
 * Update building settings (validated); re-lots if headcount grew (a lowered one shrinks the lot only once desks free). A blank name re-derives from the attachment (the new
 * one when `goalId` moves in the same patch); a typed name stays.
 */
export function updateBuilding(world: World, id: string, patch: Partial<In<typeof CreateBuildingInput>>, actor: Actor = null): Building {
  const cur = world.buildings.require(id, "building");
  const p = patchOf(CreateBuildingInput).parse(patch);
  if (p.name === "") p.name = world.goalTree.defaultName(p.goalId ?? world.goalTree.attachmentOf(cur));
  // a headcount below the desks in use is accepted: it caps the next fork (freeDesks), running forks keep their desks
  // and the lab shrinks as they free (WorldMap `drawn`)
  if (p.headcount !== undefined && p.headcount > MAX_HEADCOUNT) throw badRequest(`headcount must be <= ${MAX_HEADCOUNT}`);
  // desks per subtree (gr_yu6qw3j9x5): a raise must fit every desk total on the path (a lower one always may)
  if (p.headcount !== undefined && p.headcount > cur.headcount) world.goalTree.requireDesksFit(cur.id, world.goalTree.attachmentOf(cur), p.headcount);
  if (p.managerAgentId) {
    const a = world.agents.get(p.managerAgentId);
    if (!a || a.kind !== "resident" || a.homeBuildingId !== id || a.forkOf) throw badRequest("The manager must be a (named) resident of this building.");
    if (a.status === "stopped" || isGone(a)) throw badRequest(`Can't make ${a.name} manager: they are ${a.status}.`);
  }
  const { goalId, ...rest } = p;
  const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  const updated = world.buildings.upsert({ ...cur, ...clean });
  // the attachment moves through the tree's own path (goals.edit on both ends, a goal.attached event); it is never unset
  if (goalId !== undefined && goalId !== cur.goalId) world.goalTree.attach(actor, id, goalId);
  syncManagerRoles(world);
  world.layout.rebuild();
  world.events.append({ type: "building.updated", buildingId: id, text: `${updated.name} settings updated`, payload: { fields: Object.keys(clean) } });
  return world.buildings.require(id);
}

/**
 * Save a building's furniture (lot-relative anchors; pieces left out stay put). Throws on an illegal room.
 * Bodies follow (the rebuild's `followRelayout`): anyone at a place or meeting seat that moved goes to its new tile,
 * anyone on a now-blocked tile steps to the nearest free one, and walks are re-planned. Place ids don't change.
 */
export function updateFurniture(world: World, id: string, furniture: Furniture, by: string | null): Building {
  const b = world.buildings.require(id, "building");
  const map = world.layout;
  const preview = map.preview(id, furniture);
  if (preview.errors.length) throw badRequest(preview.errors.map((e) => e.message).join(" "));
  return world.transaction(() => {
    world.buildings.upsert({ ...b, furniture: preview.furniture });
    map.rebuild();
    world.events.append({ type: "building.layout", buildingId: id, text: `${b.name} layout changed`, payload: { by, before: b.furniture, after: preview.furniture } });
    return world.buildings.require(id);
  });
}

/**
 * After a rebuild moved places or lots (the map is drawn from the goal tree, so attaching a building, adding, moving
 * or retiring a goal, or a building's desks can move things): bodies inside a moved building move with it; anyone at a
 * place or meeting seat that moved goes to its new tile; anyone a building now stands on steps to the nearest free
 * tile. Walks in progress are re-planned along the new roads. Place ids don't change.
 */
export function followRelayout(world: World, before: Before, moved: Moved[]): void {
  const map = world.layout;
  const moves = new Map<string, Tile>();
  for (const p of map.places) {
    const old = before.places.get(p.id);
    if (old && (old.x !== p.pos.x || old.y !== p.pos.y)) moves.set(`${old.x},${old.y}`, p.pos);
    const now = map.seatsOf(p.id);
    (before.seats.get(p.id) ?? []).forEach((s, i) => { if (now[i] && !moves.has(`${s.x},${s.y}`)) moves.set(`${s.x},${s.y}`, now[i]); });
  }
  const inLot = (pos: Tile) => moved.find(({ from: l }) => pos.x >= l.x && pos.x < l.x + l.w && pos.y >= l.y && pos.y < l.y + l.h);
  const pick = (pos: Tile): Tile | null => {
    const m = inLot(pos);
    if (m) return { x: pos.x + m.to.x - m.from.x, y: pos.y + m.to.y - m.from.y };
    return map.isWalkable(pos.x, pos.y) ? null : pos;
  };
  const positions: { id: string; x: number; y: number; status: Agent["status"] }[] = [];
  for (const a of world.agents.where("status != 'retired'")) {
    const to = moves.get(`${a.pos.x},${a.pos.y}`) ?? pick(a.pos);
    if (!to) continue;
    const pos = nearestWalkable(map.grid, to);
    if (pos.x === a.pos.x && pos.y === a.pos.y) continue;
    world.agents.upsert({ ...a, pos }, { silent: true });
    positions.push({ id: a.id, x: pos.x, y: pos.y, status: a.status });
  }
  world.movement.reroute((t) => nearestWalkable(map.grid, moves.get(`${t.x},${t.y}`) ?? pick(t) ?? t));
  if (positions.length) world.changes.emit({ type: "agents.pos", positions });
}

/** Create a resident at the building's lowest free desk (a full lab grows by one); it gets `member` in that building. */
export function createResident(world: World, input: In<typeof CreateResidentInput>): Agent {
  const inp = CreateResidentInput.parse(input);
  const b = world.buildings.require(inp.buildingId, "building");
  if (b.kind !== "lab") throw badRequest("Residents live in labs.");
  return world.transaction(() => {
    const id = newId("ag");
    const existing = world.agents.count("homeBuildingId = ? AND kind = 'resident' AND forkOf IS NULL", [b.id]);
    // insert first (desk names come from the agents table), then claim the desk and move the body there
    world.agents.upsert(Agent.parse({
      id, name: inp.name || suggestResidentName(world), kind: "resident", buildingId: b.id, homeBuildingId: b.id, ownerUserId: b.createdBy ?? null,
      title: inp.title, direction: inp.direction, sprite: inp.sprite ?? (existing % 8) + 1, model: inp.model ?? STARTER_MANAGER_MODEL,
      pos: world.layout.door(b.id) ?? { x: 0, y: 0 }, status: "idle", createdAt: nowIso(),
    }), { silent: true });
    // a full lab grows by a desk (and the tree re-lots it if it no longer fits; bodies follow, see followRelayout)
    const desk = world.layout.claimDesk(b.id, id, { grow: true });
    const agent = world.agents.patch(id, { pos: desk.pos });
    world.permissions.grant(agent, buildingRoleId(b.id, "member"));
    world.events.append({ type: "agent.created", agentId: id, buildingId: b.id, text: `${agent.name} joined ${b.name}`, payload: { kind: "resident" } });
    return agent;
  });
}

function spawnPoint(world: World, buildingId?: string | null): Tile {
  const p = (buildingId && world.layout.door(buildingId)) || world.layout.place("plaza")?.pos;
  return p ? { ...p } : { x: 1, y: world.layout.grid.h - 3 };
}

/** The nearest walkable tile to `p` (within 3 tiles) no live body stands on, so two newcomers don't arrive stacked; `p` when all are taken. */
function freeTileNear(world: World, p: Tile): Tile {
  const taken = new Set(world.agents.where(NOT_GONE).map((o) => `${o.pos.x},${o.pos.y}`));
  for (let r = 0; r <= 3; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = p.x + dx, y = p.y + dy;
      if (world.layout.isWalkable(x, y) && !taken.has(`${x},${y}`)) return { x, y };
    }
  }
  return { ...p };
}

/** The lab attached to `goalId` or to the nearest goal above it (a goal under a building's goal is that building's work); undefined when the chain has none. */
function labOnChain(world: World, goalId: string): Building | undefined {
  for (const g of world.goalTree.ancestors(goalId)) {
    const b = world.buildings.first("goalId = ? AND kind = 'lab'", [g.id], "ORDER BY createdAt, id");
    if (b) return b;
  }
  return undefined;
}

/**
 * The lab a visitor working on `goalId` sits in (`labOnChain`). A goal whose chain has no lab with desks is refused:
 * the visitor `adopt`s it instead (`adoptGoal`).
 */
function visitorBuildingFor(world: World, goalId: string): Building {
  const goal = world.goalTree.get(goalId);
  if (!goal || goal.status === "retired") throw notFound("goal", goalId);
  const b = labOnChain(world, goalId);
  if (b) return b;
  throw new AppError("conflict", `No building works on "${goal.text}" or a goal above it, so it has no desks to join yet. Adopt it (\`adopt\`, POST /api/goals/${goalId}/adopt) to become its building's manager, or pick a goal that has a building.`);
}

/**
 * A visitor adopts a goal no building works on (gr_a5ct690l7a step 4; 1:1 mt_26vin80bpm): a lab is built on the goal
 * (headcount 1, its owner as the creator) and the visitor becomes its manager, homed there at a desk beyond the
 * headcount, with the building's manager role. The town never forks a visitor, so the building's queue is held
 * (`forkableManagerOf`, `visitorManagerRefusal`); offline it is unmanaged (`managerAgentOf`), and dismissing the
 * visitor clears `managerAgentId`. A goal with a lab on it or above it is refused (409): register on that goal instead.
 */
export function adoptGoal(world: World, agentId: string, goalId: string): { building: Building; agent: Agent; desk: boolean } {
  const me = world.agents.require(agentId, "agent");
  if (me.kind !== "visitor") throw new AppError("forbidden", "Only a visitor adopts a goal: a resident's building is set by the town.");
  if (isGone(me)) throw new AppError("conflict", `${me.name} is ${me.status}.`);
  const goal = world.goals.get(goalId);
  if (!goal || goal.status !== "active") throw badRequest(`${goalId} is not an active goal of the town tree.`);
  const managed = world.buildings.first("managerAgentId = ? AND kind = 'lab'", [me.id]);
  if (managed) throw new AppError("conflict", `${me.name} already manages ${managed.name}; a visitor manages one building.`);
  const lab = labOnChain(world, goalId);
  if (lab) throw new AppError("conflict", `${lab.name} already works on ${lab.goalId === goalId ? "this goal" : "a goal above it"}, so it has desks to join: register a visitor on goal ${goalId} (goalId) instead of adopting it.`);
  return world.transaction(() => {
    const b = createBuilding(world, { goalId, headcount: 1 }, me.ownerUserId ?? null);
    world.buildings.upsert({ ...b, managerAgentId: me.id });
    if (me.homeBuildingId && world.layout.deskOf(me.id)) world.layout.releaseDesk(me.id);
    world.agents.patch(me.id, { homeBuildingId: b.id });
    const desk = claimVisitorDesk(world, me.id, b.id);
    if (desk) world.movement.cancel(me.id, "Moved to a new desk.");
    const agent = desk ? world.agents.patch(me.id, { pos: desk.pos, buildingId: b.id }) : world.agents.require(me.id);
    syncManagerRoles(world);
    world.events.append({ type: "building.updated", agentId: me.id, buildingId: b.id, text: `${me.name} adopted "${goal.text}" and manages ${b.name}`, payload: { adoptedBy: me.id, goalId, fields: ["managerAgentId"] } });
    return { building: world.buildings.require(b.id), agent, desk: !!desk };
  });
}

/**
 * A user's visitor agent (Claude Code over MCP or the CLI). Returns the agent and its token. With `goalId` (or the
 * older `buildingId`) it is homed in that goal's building and gets a desk BEYOND the headcount there: it never takes a
 * fork slot (`freeDesks` leaves visitor desks out) and holds the desk while online (presence.ts releases it when the
 * visitor goes offline and claims one again when it is back). Without either it sits at the Town Hall visitor bench.
 */
export function registerVisitor(world: World, userId: string, input: In<typeof RegisterVisitorInput>): { agent: Agent; token: string } {
  const inp = RegisterVisitorInput.parse(input);
  world.users.require(userId, "user");
  const b = inp.goalId ? visitorBuildingFor(world, inp.goalId) : inp.buildingId ? world.buildings.require(inp.buildingId, "building") : null;
  return world.transaction(() => {
    const id = newId("ag");
    // insert first (desk names come from the agents table), then claim the desk and move the body there
    world.agents.upsert(Agent.parse({
      id, name: inp.name, kind: "visitor", buildingId: b?.id ?? null, homeBuildingId: b?.id ?? null,
      ownerUserId: userId, title: inp.title ?? "Visitor", sprite: 6, pos: spawnPoint(world, b?.id), createdAt: nowIso(),
      inheritsOwner: inp.inheritsOwner ?? true,
    }), { silent: true });
    const desk = b ? claimVisitorDesk(world, id, b.id) : null;
    const pos = desk ? desk.pos : world.presence.benchSeat(id);
    const agent = world.agents.patch(id, { pos, buildingId: world.layout.buildingAt(pos)?.id ?? null });
    world.permissions.ensureTownRoles();
    world.permissions.grant(agent, townRoleId("visitor"));
    // v1.5: the agent is capped by its owner, so the owner holds the visitor baseline too (GitHub sign-in already grants it)
    world.permissions.grant({ kind: "user", id: userId }, townRoleId("visitor"));
    const where = desk ? `took a desk in ${b!.name}` : "is at the visitor bench";
    world.events.append({ type: "agent.created", agentId: agent.id, buildingId: agent.homeBuildingId ?? agent.buildingId, text: `${agent.name} arrived as a visitor and ${where}`, payload: { kind: "visitor", ownerUserId: userId, desk: !!desk, goalId: inp.goalId ?? null } });
    return { agent, token: world.tokens.create("agent", agent.id) };
  });
}

/** A visitor's desk beyond the headcount in `buildingId`, or null when the building has none to give (not a lab, or at MAX_HEADCOUNT desks). */
export function claimVisitorDesk(world: World, agentId: string, buildingId: string) {
  try { return world.layout.claimDesk(buildingId, agentId, { visitor: true }); }
  catch (e) { if (e instanceof AppError && e.code === "conflict") return null; throw e; }
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
