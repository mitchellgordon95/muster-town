import {
  Agent, CreateBuildingInput, CreateResidentInput, RegisterVisitorInput,
  type Building, type Tile, type User,
} from "@agent-town/schema";
import { AppError, badRequest } from "./errors.ts";
import { buildingRoleId, townRoleId } from "./permissions.ts";
import { newId, nowIso } from "./util.ts";
import { MAX_HEADCOUNT, TOWN_HALL_ID } from "./world/layout.ts";
import type { World } from "./world.ts";

type In<T extends { _input: unknown }> = T["_input"];

export function createUser(world: World, name: string, opts: { id?: string } = {}): { user: User; token: string } {
  const user = world.users.upsert({ id: opts.id ?? newId("us"), name, createdAt: nowIso(), donatedTokens: 0, hasApiKey: false });
  return { user, token: world.tokens.create("user", user.id) };
}

/**
 * Create a building: built-in building roles (manager/reviewer/member), creator gets `manager`,
 * lot assigned, `building.created` event.
 */
export function createBuilding(
  world: World,
  input: In<typeof CreateBuildingInput>,
  creatorUserId: string | null,
  opts: { id?: string; kind?: Building["kind"] } = {},
): Building {
  const inp = CreateBuildingInput.parse(input);
  if ((inp.headcount ?? 6) > MAX_HEADCOUNT) throw badRequest(`headcount must be <= ${MAX_HEADCOUNT}`);
  const id = opts.id ?? newId("bl");
  if (world.buildings.get(id)) throw new AppError("conflict", `Building ${id} already exists.`);
  if (creatorUserId) world.users.require(creatorUserId, "user");
  return world.transaction(() => {
    const building = world.buildings.upsert({
      ...inp, id, kind: opts.kind ?? "lab", createdAt: nowIso(), createdBy: creatorUserId ?? undefined,
    } as Building);
    world.permissions.ensureTownRoles();
    world.permissions.ensureBuildingRoles(id);
    if (creatorUserId) world.permissions.grant({ kind: "user", id: creatorUserId }, buildingRoleId(id, "manager"));
    world.layout.rebuild();
    world.events.append({ type: "building.created", buildingId: id, text: `${building.name} was built`, payload: { createdBy: creatorUserId } });
    return world.buildings.require(id);
  });
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
  const clean = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
  const updated = world.buildings.upsert({ ...cur, ...clean });
  world.layout.rebuild();
  world.events.append({ type: "building.updated", buildingId: id, text: `${updated.name} settings updated`, payload: { fields: Object.keys(clean) } });
  return world.buildings.require(id);
}

/** Create a resident at the building's lowest free desk; it gets `member` in that building. */
export function createResident(world: World, input: In<typeof CreateResidentInput>): Agent {
  const inp = CreateResidentInput.parse(input);
  const b = world.buildings.require(inp.buildingId, "building");
  if (b.kind !== "lab") throw badRequest("Residents live in labs.");
  return world.transaction(() => {
    const id = newId("ag");
    const existing = world.agents.where("homeBuildingId = ? AND kind = 'resident'", [b.id]).length;
    // insert first (desk names come from the agents table), then claim the desk and move the body there
    world.agents.upsert(Agent.parse({
      id, name: inp.name, kind: "resident", buildingId: b.id, homeBuildingId: b.id, ownerUserId: b.createdBy ?? null,
      title: inp.title, direction: inp.direction, sprite: inp.sprite ?? (existing % 8) + 1, model: inp.model ?? null,
      pos: world.layout.door(b.id) ?? { x: 0, y: 0 }, status: "idle", createdAt: nowIso(),
    }), { silent: true });
    const desk = world.layout.claimDesk(b.id, id);
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
      direction: input.direction ?? "Collective-wide misuse prevention: approve outbox requests that are safe and useful, review trophy proposals, and ban agents that misuse the town. Every building keeps its own policies; you don't review research.",
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

/** A user's visitor agent (Claude Code over MCP). Returns the agent and its token. */
export function registerVisitor(world: World, userId: string, input: In<typeof RegisterVisitorInput>): { agent: Agent; token: string } {
  const inp = RegisterVisitorInput.parse(input);
  world.users.require(userId, "user");
  if (inp.buildingId) world.buildings.require(inp.buildingId, "building");
  const agent = world.agents.upsert(Agent.parse({
    id: newId("ag"), name: inp.name, kind: "visitor", buildingId: inp.buildingId ?? null, homeBuildingId: null,
    ownerUserId: userId, title: inp.title ?? "Visitor", sprite: 6, pos: spawnPoint(world, inp.buildingId), createdAt: nowIso(),
  }));
  world.permissions.ensureTownRoles();
  world.permissions.grant(agent, townRoleId("visitor"));
  world.events.append({ type: "agent.created", agentId: agent.id, buildingId: agent.buildingId, text: `${agent.name} arrived as a visitor`, payload: { kind: "visitor", ownerUserId: userId } });
  return { agent, token: world.tokens.create("agent", agent.id) };
}

/** The user's human avatar (kind `human`), created at the plaza on first call. */
export function ensureAvatar(world: World, userId: string): Agent {
  const existing = world.agents.first("kind = 'human' AND ownerUserId = ?", [userId]);
  if (existing) return existing;
  const user = world.users.require(userId, "user");
  const agent = world.agents.upsert(Agent.parse({
    id: newId("ag"), name: user.name, kind: "human", ownerUserId: userId, title: "Human", sprite: 0,
    pos: spawnPoint(world), createdAt: nowIso(),
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
