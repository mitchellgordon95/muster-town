import { AppError } from "@agent-town/core";
import { CreateBuildingInput, DonateInput, Membership, UpdateBuildingInput, type AuthMe } from "@agent-town/schema";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, adminToken, parse, requireAuth, requireUser, type Params } from "../context.ts";

const EventsQuery = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
  agentId: z.string().optional(),
  buildingId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).default(100),
});
const LimitQuery = z.object({ limit: z.coerce.number().int().positive().max(200).default(30) });

/** Town snapshot, auth info, events, buildings, roles, budget, export. */
export async function townRoutes(app: FastifyInstance) {
  const world = app.world;

  app.get("/api/health", async () => ({ ok: true, runtime: !!app.runtime, time: new Date().toISOString() }));

  if (app.dev) {
    app.get("/api/dev/admin-token", async () => {
      const token = adminToken(world);
      if (!token) throw new AppError("not_found", "No admin user yet (town not seeded).");
      return { token };
    });
  }

  app.get("/api/town", async () => {
    const { type: _type, ...snap } = world.snapshot();
    return snap;
  });

  app.get("/api/me", async (req): Promise<AuthMe> => {
    const user = requireUser(req);
    const holder = { kind: "user" as const, id: user.id };
    return {
      user,
      roles: world.permissions.rolesOf(holder),
      avatarAgentId: world.ops.ensureAvatar(user.id).id,
      isAdmin: world.permissions.isAdmin(holder),
    };
  });

  app.get("/api/events", async (req) => {
    const q = parse(EventsQuery, req.query);
    const base = { agentId: q.agentId, buildingId: q.buildingId, limit: q.limit };
    const events = q.since !== undefined ? world.events.list({ ...base, since: q.since }) : world.events.recent(base);
    return { events };
  });

  // ---- buildings ----
  app.get<{ Params: Params }>("/api/buildings/:id", async (req) => {
    const building = world.buildings.require(req.params.id, "building");
    const agents = world.agents.where("homeBuildingId = ? OR buildingId = ?", [building.id, building.id], "ORDER BY createdAt");
    const meetings = world.meetings.where("buildingId = ?", [building.id], "ORDER BY scheduledAt DESC LIMIT 20");
    const budget = world.budget.summary().buildings.find((b) => b.buildingId === building.id) ?? null;
    return { building, agents, meetings, budget, roles: world.permissions.rolesForBuilding(building.id).filter((r) => r.buildingId === building.id) };
  });

  app.post("/api/buildings", async (req, reply) => {
    const input = parse(CreateBuildingInput, req.body);
    const building = world.ops.createBuilding(actorOf(world, req), input);
    return reply.code(201).send({ building });
  });

  app.patch<{ Params: Params }>("/api/buildings/:id", async (req) => {
    const input = parse(UpdateBuildingInput, req.body);
    return { building: world.ops.updateBuilding(actorOf(world, req), req.params.id, input) };
  });

  app.get<{ Params: Params }>("/api/buildings/:id/board", async (req) => {
    const { limit } = parse(LimitQuery, req.query);
    world.buildings.require(req.params.id, "building");
    const docs = world.docs.where("buildingId = ? AND state = 'building'", [req.params.id], `ORDER BY updatedAt DESC, rowid DESC LIMIT ${limit}`);
    return { docs };
  });

  // ---- roles ----
  app.get("/api/roles", async (req) => {
    const { buildingId } = parse(z.object({ buildingId: z.string().optional() }), req.query);
    const roles = world.permissions.rolesForBuilding(buildingId);
    const memberships = roles.flatMap((r) => world.memberships.forRole(r.id));
    return { roles, memberships };
  });

  app.post("/api/roles/assign", async (req) => {
    const m = parse(Membership, req.body);
    world.ops.assignRole(actorOf(world, req), m);
    return { ok: true, membership: m };
  });

  app.delete("/api/roles/assign", async (req) => {
    const m = parse(Membership, req.body);
    world.ops.unassignRole(actorOf(world, req), m);
    return { ok: true, membership: m };
  });

  // ---- budget ----
  app.post("/api/donate", async (req, reply) => {
    const user = requireUser(req);
    const input = parse(DonateInput, req.body);
    const allocation = world.budget.donate(user.id, input);
    return reply.code(201).send({ allocation });
  });

  app.get("/api/budget", async () => {
    const s = world.budget.summary();
    return {
      // both naming styles: core's (allocatedTokens/…) and the web client's (allocated/spent/donated)
      buildings: s.buildings.map((b) => ({ ...b, allocated: b.allocatedTokens, spent: b.spentTokens })),
      users: s.users.map((u) => ({ ...u, donated: u.donatedTokens })),
    };
  });

  // ---- export ----
  app.post("/api/export", async (req) => {
    const actor = actorOf(world, req);
    if (!world.permissions.isAdmin(actor) && !world.permissions.can(actor, "town.manage_buildings")) {
      throw new AppError("forbidden", "Only admins can run the export.");
    }
    requireAuth(req);
    const r = world.export(process.env.AGENT_TOWN_EXPORT ?? "./export");
    return { commit: r.commit, changed: r.changed, files: r.files, dir: r.dir };
  });
}
