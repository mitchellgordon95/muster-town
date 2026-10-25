import { AppError, boardDocs, cabinetCounts, cabinetDocs } from "@muster-town/core";
import { AddBankInput, CreateBankPoolInput, CreateBuildingInput, DesksPatch, UpdateBankPoolInput, DocType, DonateInput, LayoutInput, Membership, PlanInput, RedeployInput, UpdateBuildingInput, townEnv, type AuthMe, type RedeployLive } from "@muster-town/schema";
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
    const building = { ...world.buildings.require(req.params.id, "building"), intray: world.ops.intrayCount(req.params.id) };
    const agents = world.agents.where("(homeBuildingId = ? OR buildingId = ?) AND status != 'retired'", [building.id, building.id], "ORDER BY createdAt");
    const meetings = world.meetings.where("buildingId = ?", [building.id], "ORDER BY scheduledAt DESC LIMIT 20");
    const budget = world.budget.summary().buildings.find((b) => b.buildingId === building.id) ?? null;
    return {
      building, agents, meetings, budget, roles: world.permissions.rolesForBuilding(building.id).filter((r) => r.buildingId === building.id),
      // goal-directed: the goal's key results (each with its live grant, if any) and the blocked reason (null = not blocked)
      keyResults: world.grantDesk.keyResults(building.id), blocked: world.grantDesk.blocked(building),
    };
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
  /** Host settings that change live (admin): `{maxRunning}` = how many work sessions may run at once. → { desks, slots } */
  app.put("/api/town/desks", async (req) => {
    const user = requireUser(req);
    if (!world.permissions.isAdmin({ kind: "user", id: user.id })) throw new AppError("forbidden", "Only an admin can change the host's session slots.", 403);
    const desks = world.setDesksConfig(parse(DesksPatch, req.body));
    return { desks, slots: world.host.slots?.() ?? null };
  });

  app.put("/api/town/plan", async (req) => {
    const input = parse(PlanInput, req.body);
    const actor = actorOf(world, req);
    if (input.dryRun) return world.ops.planPreview(actor, input.lots, input.create);
    return world.ops.planTown(actor, input.lots, input.create);
  });

  /**
   * The building's in-tray: pending reports, oldest first. Readable by anyone. Reports live here, not on the board.
   * The Town Hall's holds the manager agents' reports (rollups, checkpoints, escalations) and, as `grants`, the
   * proposals, counters and checkpoints a human must decide on.
   */
  app.get<{ Params: Params }>("/api/buildings/:id/intray", async (req) => {
    const b = world.buildings.require(req.params.id, "building");
    if (b.kind === "town-hall") return world.ops.townHallIntray();
    return { reports: world.ops.intray(b.id) };
  });

  app.get<{ Params: Params }>("/api/buildings/:id/board", async (req) => {
    const { limit } = parse(LimitQuery, req.query);
    world.buildings.require(req.params.id, "building");
    return { docs: boardDocs(world, req.params.id, limit), ...world.grantDesk.board(req.params.id) };
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
  /** Admins and holders of town.allocate_budget may fund buildings with the town's own credentials (subscription, API key). */
  const canAllocate = (req: FastifyRequest) => {
    const a = requireAuth(req);
    const holder = a.kind === "user" ? { kind: "user" as const, id: a.user.id } : world.agents.require(a.agent.id, "agent");
    return world.permissions.isAdmin(holder) || world.permissions.can(holder, "town.allocate_budget");
  };

  app.post("/api/donate", async (req, reply) => {
    const user = requireUser(req);
    const input = parse(DonateInput, req.body);
    // without an explicit auth: donor-key when the donor gives or has a key, else the town's API key
    const auth = input.auth ?? (input.apiKey || world.users.require(user.id).hasApiKey ? "donor-key" : "api-key");
    if (auth !== "donor-key" && !canAllocate(req)) {
      throw new AppError("forbidden", auth === "subscription"
        ? "Only an admin can fund a building from the subscription."
        : "Only an admin can fund a building from the town's API key; donate with your own key instead.");
    }
    const allocation = world.budget.donate(user.id, { ...input, auth });
    return reply.code(201).send({ allocation });
  });

  /** A building's allocations (retired ones too, for their history), newest first, each with what's left. */
  app.get<{ Querystring: { buildingId?: string } }>("/api/allocations", async (req) => {
    const bid = req.query.buildingId;
    const rows = bid ? world.budget.allocationsOf(bid) : world.allocations.all("ORDER BY createdAt DESC, rowid DESC");
    return {
      allocations: rows.map((a) => ({ ...a, remainingTokens: a.retired ? 0 : Math.max(0, a.tokens - a.spentTokens), userName: world.users.get(a.userId)?.name ?? a.userId })),
    };
  });

  /** Retire an allocation: never drawn from again and out of the building's budget; its spend history stays. */
  app.post<{ Params: Params }>("/api/allocations/:id/retire", async (req) => {
    if (!canAllocate(req)) throw new AppError("forbidden", "Only an admin can retire an allocation.");
    return { allocation: world.budget.retire(req.params.id, actorOf(world, req).name) };
  });

  /**
   * Retire the placeholder allocations (labelled house/placeholder, plus `ids`; with `unlabelled`, every unlabelled
   * non-donor allocation from before labels existed). `dryRun` lists them without retiring. Admin only.
   */
  app.post("/api/allocations/retire-placeholders", async (req) => {
    const a = requireAuth(req);
    if (a.kind !== "user" || !world.permissions.isAdmin({ kind: "user", id: a.user.id })) throw new AppError("forbidden", "Only an admin can retire placeholder allocations.");
    const body = parse(z.object({ ids: z.array(z.string()).default([]), unlabelled: z.boolean().default(false), dryRun: z.boolean().default(false) }), req.body ?? {});
    return { allocations: world.budget.retirePlaceholders({ ...body, byName: actorOf(world, req).name }), dryRun: body.dryRun };
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

  // accounting pools: buildings join a pool (PATCH /api/buildings/:id {poolId}); pools get the % of the Bank
  app.get("/api/bank/pools", async () => ({ pools: world.bank.summary().pools }));

  app.post("/api/bank/pools", async (req, reply) => {
    const user = requireUser(req);
    const pool = world.bank.createPool(user.id, parse(CreateBankPoolInput, req.body));
    return reply.code(201).send({ pool, bank: world.bank.summary() });
  });

  app.patch<{ Params: Params }>("/api/bank/pools/:id", async (req) => {
    const user = requireUser(req);
    const pool = world.bank.updatePool(user.id, req.params.id, parse(UpdateBankPoolInput, req.body));
    return { pool, bank: world.bank.summary() };
  });

  app.delete<{ Params: Params }>("/api/bank/pools/:id", async (req) => {
    const user = requireUser(req);
    world.bank.deletePool(user.id, req.params.id);
    return { bank: world.bank.summary() };
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
  /** The runtime's live view (anyone may read it, like the redeploy events): the HUD checks its event-derived banner against this. */
  app.get("/api/admin/redeploy", async (): Promise<RedeployLive> =>
    world.host.redeployStatus?.() ?? { running: false, phase: "idle", waitingFor: [], since: null });
  app.post("/api/admin/redeploy", async (req, reply) => {
    const actor = actorOf(world, req);
    world.permissions.require(actor, "town.redeploy");
    const input = parse(RedeployInput, req.body);
    if (!app.runtime?.redeploy) throw new AppError("internal", "runtime not available", 503);
    const r = await app.runtime.redeploy({ image: input.image, requestedBy: actor.name });
    return reply.code(r.started ? 202 : 200).send(r);
  });
}
