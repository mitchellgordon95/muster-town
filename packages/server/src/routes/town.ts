import { AppError, boardDocs, cabinetCounts, cabinetDocs } from "@muster-town/core";
import { AddBankInput, CreateBuildingInput, SetBankShareInput, DocType, DonateInput, LayoutInput, Membership, PlanInput, RedeployInput, UpdateBuildingInput, townEnv, type AuthMe } from "@muster-town/schema";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { actorOf, adminToken, parse, requireAuth, requireUser, type Params } from "../context.ts";

const EventsQuery = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
  agentId: z.string().optional(),
  buildingId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).default(100),
});
const LimitQuery = z.object({ limit: z.coerce.number().int().positive().max(200).default(30) });
const CabinetQuery = LimitQuery.extend({ type: DocType.optional(), authorId: z.string().optional() });

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** From this machine and not relayed: a reverse proxy or tunnel also connects from loopback, but adds forwarding headers. */
function isLocalDirect(req: FastifyRequest): boolean {
  const h = req.headers;
  return LOOPBACK.has(req.socket.remoteAddress ?? "") && !h["x-forwarded-for"] && !h.forwarded && !h["x-real-ip"] && !h["cf-connecting-ip"];
}

/** Town snapshot, auth info, events, buildings, roles, budget, bank, export, redeploy. */
export async function townRoutes(app: FastifyInstance) {
  const world = app.world;

  /** `commit`: the git sha the running server started from (null without a runtime); `git merge-base --is-ancestor <sha> <commit>` says whether a change is live */
  app.get("/api/health", async () => ({ ok: true, runtime: !!app.runtime, commit: world.host.commit ?? null, time: new Date().toISOString() }));

  if (app.dev) {
    // only to a browser on this machine talking to the server directly: never through a proxy or tunnel
    app.get("/api/dev/admin-token", async (req) => {
      if (!isLocalDirect(req)) throw new AppError("forbidden", "The dev admin token is only served to direct loopback requests.");
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
    const building = { ...world.buildings.require(req.params.id, "building"), intray: world.ops.intray(req.params.id).length };
    const agents = world.agents.where("(homeBuildingId = ? OR buildingId = ?) AND status != 'retired'", [building.id, building.id], "ORDER BY createdAt");
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

  /** Movable furniture: each piece's footprint, stand tiles, default and current anchor (lot-relative). */
  app.get<{ Params: Params }>("/api/buildings/:id/layout", async (req) => world.layout.pieces(req.params.id));

  /** Rearrange furniture (humans with building.manage). `dryRun` returns errors and the grid as it would look. */
  app.put<{ Params: Params }>("/api/buildings/:id/layout", async (req) => {
    const input = parse(LayoutInput, req.body);
    const actor = actorOf(world, req);
    if (input.dryRun) return world.ops.layoutPreview(actor, req.params.id, input.furniture);
    return { building: world.ops.updateFurniture(actor, req.params.id, input.furniture) };
  });

  /**
   * Town planning (humans with town.manage_buildings): new lots for existing buildings and/or one new building on
   * a drawn lot. `dryRun` returns errors and the grid as it would look.
   */
  app.put("/api/town/plan", async (req) => {
    const input = parse(PlanInput, req.body);
    const actor = actorOf(world, req);
    if (input.dryRun) return world.ops.planPreview(actor, input.lots, input.create);
    return world.ops.planTown(actor, input.lots, input.create);
  });

  /** The building's in-tray: pending reports, oldest first. Readable by anyone. Reports live here, not on the board. */
  app.get<{ Params: Params }>("/api/buildings/:id/intray", async (req) => {
    return { reports: world.ops.intray(req.params.id) };
  });

  app.get<{ Params: Params }>("/api/buildings/:id/board", async (req) => {
    const { limit } = parse(LimitQuery, req.query);
    world.buildings.require(req.params.id, "building");
    return { docs: boardDocs(world, req.params.id, limit) };
  });

  /**
   * The filing cabinet: everything the building has published except board FYIs, newest first, optionally narrowed
   * to one doc type and/or author. `counts` (per type and author, unfiltered) drives the folder counts and author filter.
   */
  app.get<{ Params: Params }>("/api/buildings/:id/cabinet", async (req) => {
    const { limit, type, authorId } = parse(CabinetQuery, req.query);
    world.buildings.require(req.params.id, "building");
    return { docs: cabinetDocs(world, req.params.id, limit, { type, authorId }), counts: cabinetCounts(world, req.params.id) };
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

  // ---- bank ----
  app.get("/api/bank", async () => world.bank.summary());

  app.post("/api/bank/inputs", async (req, reply) => {
    const user = requireUser(req);
    const input = world.bank.addInput(user.id, parse(AddBankInput, req.body));
    return reply.code(201).send({ input });
  });

  app.delete<{ Params: Params }>("/api/bank/inputs/:id", async (req) => {
    const user = requireUser(req);
    return { input: world.bank.cancelInput(user.id, req.params.id) };
  });

  app.put<{ Params: { buildingId: string } }>("/api/bank/shares/:buildingId", async (req) => {
    const user = requireUser(req);
    world.bank.setShare(user.id, req.params.buildingId, parse(SetBankShareInput, req.body));
    return world.bank.summary();
  });

  // ---- export ----
  app.post("/api/export", async (req) => {
    const actor = actorOf(world, req);
    if (!world.permissions.isAdmin(actor) && !world.permissions.can(actor, "town.manage_buildings")) {
      throw new AppError("forbidden", "Only admins can run the export.");
    }
    requireAuth(req);
    const r = world.export(townEnv("EXPORT") ?? "./export");
    return { commit: r.commit, changed: r.changed, files: r.files, dir: r.dir };
  });

  // ---- redeploy (v1.3): pull main, rebuild, restart; progress arrives as `system` events ----
  app.post("/api/admin/redeploy", async (req, reply) => {
    const actor = actorOf(world, req);
    world.permissions.require(actor, "town.redeploy");
    const input = parse(RedeployInput, req.body);
    if (!app.runtime?.redeploy) throw new AppError("internal", "runtime not available", 503);
    const r = await app.runtime.redeploy({ image: input.image, requestedBy: actor.name });
    return reply.code(r.started ? 202 : 200).send(r);
  });
}
