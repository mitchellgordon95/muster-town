import { AppError, BANK_ACCOUNTING, deskPreset, deskSizeFor, type World, buildingStats, accessContext, accessRequestOf, boardWithTownDocs, canInteract, decideAccess, pendingAccessRequests, deskSlotRows, requestAccess, sessionView, setDeskSlot, cabinetCounts, cabinetDocs, reportChains, reviewDeck, presentedReviewDeck, intrayRoutes, funderWeek } from "@muster-town/core";
import { funderSlide, AccessDecisionInput, AccessRequestInput, AddBankInput, CreateBuildingInput, DesksPatch, MapLayout, TownDefaultsPatch, DocType, DonateInput, LayoutInput, Membership, PlantFlagInput, RedeployInput, UpdateBuildingInput, apiKeyProblem, townEnv, REVIEW_DECK_ID, type AccessRequest, type AuthMe, type RedeployLive } from "@muster-town/schema";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { brotliDecompressSync } from "node:zlib";
import { z } from "zod";
import { actorOf, adminToken, funderOf, parse, requireAuth, requireUser, viewerOf, type Params } from "../context.ts";

const EventsQuery = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
  agentId: z.string().optional(),
  buildingId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).default(100),
});
const SessionsQuery = z.object({ agentId: z.string().optional(), limit: z.coerce.number().int().positive().max(200).default(50) });
const FunderQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) });
const LimitQuery = z.object({ limit: z.coerce.number().int().positive().max(200).default(30) });
const CabinetQuery = LimitQuery.extend({ type: DocType.optional(), authorId: z.string().optional() });
/** A desk slot's sandbox (Machine or container) and home volume names (manager forks step 7, volume adoption). */
const DeskSlotPut = z.object({ sandboxName: z.string().trim().min(1).max(80), volumeName: z.string().trim().min(1).max(80) });

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** From this machine and not relayed: a reverse proxy or tunnel also connects from loopback, but adds forwarding headers. */
function isLocalDirect(req: FastifyRequest): boolean {
  const h = req.headers;
  return LOOPBACK.has(req.socket.remoteAddress ?? "") && !h["x-forwarded-for"] && !h.forwarded && !h["x-real-ip"] && !h["cf-connecting-ip"];
}

/** Town snapshot, auth info, events, buildings, roles, budget, bank, export, redeploy. */
export async function townRoutes(app: FastifyInstance) {
  const world = app.world;

  /**
   * `commit`: the git sha the running server started from (null without a runtime); `git merge-base --is-ancestor <sha> <commit>` says
   * whether a change is live. `load` (read-only): `lagMs` p99 event-loop delay over the last 10 s window, `rssMb`, `wsClients` open now,
   * `tick` `{last, slow}`: the runtime's last tick and last tick over 500 ms, `{at, ms, phase, phaseMs, phases}` (null without a runtime).
   * `backup` (read-only): the off-site copy's `{lastAt, bytes, dest, error}`; null until the bucket and key are set
   * (deploy/README.md "Backups"). Never the key or the bucket credentials. `monitor` (read-only, null without one):
   * `{lastSampleAt, alerts: [{key, level, since, value}]}` (monitor.ts; the VPS pinger reads the red ones). `directory` (root app, only where the
   * directory is on): `{verified, listed, pending, lastTickAt}` (directory/index.ts). `desks` (gr_uhh6u39vv9 step 3): `{backend, size,
   * billCapUsd, billTodayUsd, billPct, overCap, day}`, today's (UTC) desk bill at Fly list prices against the town-wide cap.
   */
  app.get("/api/health", async () => ({ ok: true, runtime: !!app.runtime, commit: world.host.commit ?? null, startedAt: world.host.startedAt ?? null, time: new Date().toISOString(), accounting: BANK_ACCOUNTING, load: { ...app.load.snapshot(), tick: app.runtime?.tickStats?.() ?? null },
    // goal-directed budgets: exploration (held only with no free tokens or at a goal's cap) and directed (a human asked; metered, never held) today
    budgets: world.grantDesk.laneBudgets(), backup: app.backup?.snapshot() ?? null, monitor: app.monitor?.view() ?? null, desks: desksHealth(world),
    // the root app (the Workshop) only: how many hosted collectives this process serves at /<slug>/
    ...(app.hub ? { hosted: { count: app.hub.count } } : {}),
    // the self-hosted towns directory (root app where it's on): {verified, listed, pending, lastTickAt}
    ...(app.directory ? { directory: app.directory.view() } : {}),
    // a hosted collective: its own key or none (its agents are held), never the host's funding
    ...(world.host.hosted ? { funding: world.bank.liveApiKeyInput() ? "api-key" : "none" } : {}) }));

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
      canInteract: canInteract(world, user.id),
      accessRequest: accessView(world, accessRequestOf(world, user.id)),
    };
  });

  // Who may interact (dc_f0cumcfubk): a signed-in visitor asks to join; an admin lets them in from the Town Hall in-tray.
  app.post("/api/access-requests", async (req) => {
    const user = requireUser(req);
    const input = parse(AccessRequestInput, req.body);
    return { accessRequest: requestAccess(world, user.id, input.message ?? "") };
  });

  // pending requests for the admin's HUD notice (gr_fibsfwr4tz step 2): only who may decide them (`town.manage_roles`)
  app.get("/api/access-requests", async (req) => {
    world.permissions.require(actorOf(world, req), "town.manage_roles");
    return { access: pendingAccessRequests(world) };
  });

  app.post<{ Params: Params }>("/api/access-requests/:id/decide", async (req) => {
    const input = parse(AccessDecisionInput, req.body);
    return { accessRequest: decideAccess(world, actorOf(world, req), req.params.id, input.grant) };
  });

  app.get("/api/events", async (req) => {
    const q = parse(EventsQuery, req.query);
    const base = { agentId: q.agentId, buildingId: q.buildingId, limit: q.limit };
    const events = q.since !== undefined ? world.events.list({ ...base, since: q.since }) : world.events.recent(base);
    return { events };
  });

  /**
   * Sessions, newest first (`agentId` narrows to one agent): each with the raw `tokens`, the five counters, `byModel` and
   * `adjustedOutputTokens` (Bank step 2, derived from the counters at list-price weights, never stored).
   */
  app.get("/api/sessions", async (req) => {
    const q = parse(SessionsQuery, req.query);
    const rows = q.agentId
      ? world.sessions.where("agentId = ?", [q.agentId], `ORDER BY startedAt DESC, rowid DESC LIMIT ${q.limit}`)
      : world.sessions.where("1 = 1", [], `ORDER BY startedAt DESC, rowid DESC LIMIT ${q.limit}`);
    return { sessions: rows.map(sessionView) };
  });

  /** Whether the caller may read a session's transcript: an admin, a manager of its building, or the session's agent. */
  const canReadTranscript = (req: FastifyRequest, sessionId: string): boolean => {
    const a = req.auth;
    const s = world.sessions.get(sessionId);
    if (!a || !s) return false;
    if (a.kind === "user" && world.permissions.isUserAdmin(a.user.id)) return true;
    return world.transcripts.canRead(actorOf(world, req), s);
  };

  /** One session: `{ session, transcript }`; `transcript` (size, expiry, url) only for those who may read it, else null. */
  app.get<{ Params: Params }>("/api/sessions/:id", async (req) => {
    const s = world.sessions.require(req.params.id, "session");
    return { session: sessionView(s), transcript: canReadTranscript(req, s.id) ? world.transcripts.info(s.id) : null };
  });

  /**
   * The session's SDK transcript as JSONL (docs/transcripts.md), shown as text (`?download=1` saves it as a file).
   * Admins, managers of the session's building and the session's agent; others get 403, a session without one 404.
   */
  app.get<{ Params: Params; Querystring: { download?: string } }>("/api/sessions/:id/transcript", async (req, reply) => {
    const s = world.sessions.require(req.params.id, "session");
    if (!req.auth) throw new AppError("unauthorized", "Sign in to read a session transcript.");
    if (!canReadTranscript(req, s.id)) throw new AppError("forbidden", "Only an admin, a manager of the session's building or the agent itself can read its transcript.");
    const data = world.transcripts.read(s.id);
    if (!data) throw new AppError("not_found", `No transcript kept for session ${s.id}.`);
    reply.header("content-type", "text/plain; charset=utf-8").header("x-content-type-options", "nosniff").header("cache-control", "private, no-store")
      .header("content-disposition", `${req.query.download ? "attachment" : "inline"}; filename="${s.id}.jsonl"`);
    if (/\bbr\b/.test(String(req.headers["accept-encoding"] ?? ""))) return reply.header("content-encoding", "br").send(data);
    return reply.send(brotliDecompressSync(data));
  });

  // ---- buildings ----
  app.get<{ Params: Params }>("/api/buildings/:id", async (req) => {
    const building = { ...world.buildings.require(req.params.id, "building"), intray: world.ops.intrayCount(req.params.id) };
    const agents = world.agents.where("(homeBuildingId = ? OR buildingId = ?) AND status != 'retired'", [building.id, building.id], "ORDER BY createdAt");
    const meetings = world.meetings.where("buildingId = ?", [building.id], "ORDER BY scheduledAt DESC LIMIT 20");
    const budget = world.budget.summary().buildings.find((b) => b.buildingId === building.id) ?? null;
    return {
      building, agents, meetings, budget, roles: world.permissions.rolesForBuilding(building.id).filter((r) => r.buildingId === building.id),
      // goal-directed: the goal's key results (each with its live grant, if any), the blocked reason (null = not blocked) and the stoplight
      keyResults: world.grantDesk.keyResults(building.id), blocked: world.grantDesk.blocked(building), stoplight: world.grantDesk.stoplight(building),
    };
  });

  // town planning's side bar: the building's assignments running / queued / scheduled, its agents and forks, the live commit
  app.get<{ Params: Params }>("/api/buildings/:id/stats", async (req) => {
    world.buildings.require(req.params.id, "building");
    return { stats: buildingStats(world, req.params.id) };
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
   * Manager forks, step 7 (volume adoption, dc_mymt27yz25 §8): the building's desks (n → the named resident or fork
   * sitting there) and its desk slots (n → the sandbox and home volume a fork at that desk gets, table desk_slots).
   * Needs building.manage (or admin). → { desks, slots }
   */
  app.get<{ Params: Params }>("/api/buildings/:id/desk-slots", async (req) => {
    const b = world.buildings.require(req.params.id, "building");
    world.permissions.require(actorOf(world, req), "building.manage", b.id);
    return deskSlotsView(b.id);
  });

  /**
   * Point a desk slot at a sandbox and home volume, e.g. a retired resident's `deskhome-<agentId>` so its ~/pw, notes
   * and checkouts carry over to the forks at that desk. Needs building.manage (or admin). The slot's old sandbox, if
   * one exists, mounts the new volume only after it is removed while idle (the image-push recreate does that). → { slot, desks, slots }
   */
  app.put<{ Params: Params & { n: string } }>("/api/buildings/:id/desk-slots/:n", async (req) => {
    const b = world.buildings.require(req.params.id, "building");
    const actor = actorOf(world, req);
    world.permissions.require(actor, "building.manage", b.id);
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 0 || n >= b.headcount) throw new AppError("bad_request", `Desk slot ${req.params.n} isn't one of ${b.name}'s desks (headcount ${b.headcount}).`, 400);
    const names = parse(DeskSlotPut, req.body);
    const slot = setDeskSlot(world, b.id, n, names);
    world.events.append({ type: "building.updated", buildingId: b.id, agentId: actor.id, text: `${b.name} desk slot ${n} → ${names.volumeName} (${names.sandboxName})`, payload: { fields: ["deskSlot"], deskSlot: slot } });
    return { slot, ...deskSlotsView(b.id) };
  });
  function deskSlotsView(buildingId: string) {
    const desks = (world.db.prepare("SELECT n, agentId FROM desks WHERE buildingId = ? ORDER BY n").all(buildingId) as { n: number; agentId: string }[])
      .map((d) => ({ ...d, agentName: world.agents.get(d.agentId)?.name ?? null }));
    return { desks, slots: deskSlotRows(world, buildingId) };
  }

  /** Host settings that change live (admin): `{maxRunning}` = how many work sessions may run at once. → { desks, slots } */
  app.put("/api/town/desks", async (req) => {
    const user = requireUser(req);
    world.permissions.requireAdmin({ kind: "user", id: user.id }, "Only an admin can change the host's session slots.");
    const desks = world.setDesksConfig(parse(DesksPatch, req.body));
    return { desks, slots: world.host.slots?.() ?? null };
  });

  /**
   * The operating reserve (admin; 1:1 mt_lb7tm75jgb): `{tokens}` of the general balance that exploration and grant funding
   * can't claim; 1:1s, meetings, manage and directed sessions still draw on it. → { operatingReserveTokens, free }
   */
  app.put("/api/town/operating-reserve", async (req) => {
    const user = requireUser(req);
    world.permissions.requireAdmin({ kind: "user", id: user.id }, "Only an admin can change the operating reserve.");
    const { tokens } = parse(z.object({ tokens: z.number().int().nonnegative() }), req.body);
    return { operatingReserveTokens: world.setOperatingReserve(tokens, world.ops.ensureAvatar(user.id).id), free: world.bank.freeTokens?.() ?? null };
  });

  /**
   * The map's shape, town-wide (1:1 mt_q10xf3bkoq): `{layout: "fountain" | "tree" | "radial"}`, by an admin or a goal
   * owner. Redraws the map for everyone at once. → { mapLayout }
   */
  app.put("/api/town/map-layout", async (req) => {
    const user = requireUser(req);
    const { layout } = parse(z.object({ layout: MapLayout }), req.body);
    return { mapLayout: world.setMapLayout(layout, world.ops.ensureAvatar(user.id)) };
  });

  /**
   * The collective defaults (admin; 1:1 mt_n25udpflus decision 3): model, cheap model, max turns, daily budget per agent
   * and code access for every building. Saving writes them through to every lab. → { defaults, buildings }
   */
  app.put("/api/town/defaults", async (req) => {
    const user = requireUser(req);
    world.permissions.requireAdmin({ kind: "user", id: user.id }, "Only an admin can change the collective defaults.");
    return world.setTownDefaults(parse(TownDefaultsPatch, req.body), world.ops.ensureAvatar(user.id).id);
  });

  /**
   * The building's in-tray: pending reports, oldest first. Readable by anyone. Reports live here, not on the board.
   * The Town Hall's holds the manager agents' reports (rollups, checkpoints, escalations) and, as `grants`, the
   * proposals, counters and checkpoints a human must decide on.
   */
  app.get<{ Params: Params }>("/api/buildings/:id/intray", async (req) => {
    const b = world.buildings.require(req.params.id, "building");
    if (b.kind === "town-hall") {
      // routes: each item's goal, owner, "Mine" and whether this viewer may decide it (docs/goals.md step 4)
      const intray = world.ops.townHallIntray();
      return { ...intray, ...intrayRoutes(world, viewerOf(world, req), intray) };
    }
    // chains: fork-authored reports' place on their assignment chain (the in-tray row's chain badge)
    const reports = world.ops.intray(b.id);
    return { reports, chains: reportChains(world, reports) };
  });

  /**
   * The review deck (design dc_y7a8g257of §2): the Town Hall in-tray as slides, computed on each request from the
   * in-tray and key results (zero tokens). Readable by anyone, like the in-tray. `?meeting=<id>`: the deck as that
   * meeting presents it, its slide list pinned (a decided item's slide stays at its number, marked `decided`).
   */
  app.get<{ Querystring: { meeting?: string } }>("/api/review-deck", async (req) => {
    const deck = req.query.meeting ? world.meetings.get(req.query.meeting)?.deck : null;
    const intray = world.ops.townHallIntray();
    const routes = intrayRoutes(world, viewerOf(world, req), intray);
    if (!deck?.pinned || deck.docId !== REVIEW_DECK_ID) return { ...reviewDeck(world), ...routes };
    const { pinned: _pinned, ...d } = presentedReviewDeck(world, deck.pinned);
    return { ...d, ...routes };
  });

  /** A human plants a flag (a short request) in a building: a pending `flag` doc in its in-tray for the manager to delegate (`building.assign`). */
  app.post<{ Params: Params }>("/api/buildings/:id/flags", async (req, reply) => {
    const doc = world.ops.plantFlag(actorOf(world, req), req.params.id, parse(PlantFlagInput, req.body).text);
    reply.code(201);
    return { doc };
  });

  app.get<{ Params: Params }>("/api/buildings/:id/board", async (req) => {
    const { limit } = parse(LimitQuery, req.query);
    world.buildings.require(req.params.id, "building");
    return { docs: boardWithTownDocs(world, req.params.id, limit), ...world.grantDesk.board(req.params.id) };
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
    if (world.host.hosted && auth === "subscription") throw new AppError("bad_request", "A hosted collective runs on an Anthropic API key only.");
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
    const onlyAdmin = "Only an admin can retire placeholder allocations.";
    if (a.kind !== "user") throw new AppError("forbidden", onlyAdmin); // a user's own call, never an agent token
    world.permissions.requireAdmin({ kind: "user", id: a.user.id }, onlyAdmin);
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
  // public, read-only: total received, used, expired, left, overdrawn and a 30-day projection (docs/bank.md "Finance")
  // `free`: the town-wide free tokens (docs/how-work-gets-done.md §7; core free-tokens.ts), the one number exploration reads
  app.get("/api/finance", async () => ({ ...world.bank.finance(), free: world.bank.freeTokens?.() ?? null }));
  // public, read-only: `used` by building → grant → assignment from the sessions table; rows sum to used (gr_8gtgmd828o)
  app.get("/api/finance/spend", async () => world.bank.spend());
  app.get("/api/finance/sources", async () => world.bank.sources());
  // the Fly.io hosting estimate (Bank Transparency, 1:1 mt_s6f8mvjw9h): desks priced only on the fly backend, the town Machine only when the server runs on one;
  // the daily desk bill cap is Prod's desk-perf step 3 (gr_uhh6u39vv9): desks.billCapUsd, as health `desks` shows it
  app.get<{ Querystring: { days?: string } }>("/api/finance/fly", async (req) => {
    const desks = world.desksConfig();
    const days = req.query.days ? Number(req.query.days) : undefined;
    return world.bank.fly(desks, !!process.env.FLY_APP_NAME, { capUsdPerDay: desks.billCapUsd, windowDays: Number.isFinite(days) ? days : undefined });
  });

  app.post("/api/bank/inputs", async (req, reply) => {
    const user = requireUser(req);
    const body = parse(AddBankInput, req.body);
    // a hosted collective runs on API keys only: no subscription inputs (docs/hosted-collectives.md, own-key block)
    if (world.host.hosted && body.source !== "api-key") throw new AppError("bad_request", "A hosted collective runs on an Anthropic API key only.");
    if (world.host.hosted && body.apiKey && apiKeyProblem(body.apiKey)) throw new AppError("bad_request", apiKeyProblem(body.apiKey)!);
    const input = world.bank.addInput(user.id, body);
    return reply.code(201).send({ input });
  });

  app.delete<{ Params: Params }>("/api/bank/inputs/:id", async (req) => {
    const user = requireUser(req);
    return { input: world.bank.cancelInput(user.id, req.params.id) };
  });

  // public, read-only: every funding stream (earmarks too), what each can still pay, and the expected session size a key
  // stream must cover to be picked (goal tree step 7; the Donate form's small-donation warning reads it)
  app.get("/api/bank/streams", async () => world.streams.list());

  /**
   * The funder filter (docs/goals.md "Funder attribution", goal tree build step 8): one funder's window, read-only. The
   * literal story (sessions on their key or their grant's input), the pro rata story (their share of the subscription
   * week), the goals their money reached, and the deck's slide 1 for it. `me` = the signed-in human; guests get 401.
   */
  app.get<{ Params: { userId: string } }>("/api/funders/:userId/week", async (req) => {
    const week = funderWeek(world, funderOf(req, req.params.userId), parse(FunderQuery, req.query).days);
    return { ...week, slide: funderSlide(week) };
  });

  // Bank step 4: run the drift job by hand for a UTC day (default today so far); admins only
  app.post("/api/bank/drift", async (req) => {
    const user = requireUser(req);
    const day = String((req.body as { day?: unknown } | undefined)?.day ?? new Date().toISOString().slice(0, 10));
    return { rows: world.bank.runDriftByHand(user.id, day), bank: world.bank.summary() };
  });

  // ---- export ----
  app.post("/api/export", async (req) => {
    const actor = actorOf(world, req);
    if (!world.permissions.isAdmin(actor) && !world.permissions.can(actor, "town.manage_buildings")) {
      throw new AppError("forbidden", "Only admins can run the export.");
    }
    requireAuth(req);
    const r = world.export(app.exportDir ?? townEnv("EXPORT") ?? "./export");
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

  /**
   * Monitor (monitor.ts): one red test alert (event + FYI; the server sends no SMS or email); admins only.
   * `?metric=<key>` (e.g. `desk-steal`) tags it with that metric's key; default key `test`.
   */
  app.post("/api/admin/monitor/test", async (req) => {
    const user = requireUser(req);
    world.permissions.requireAdmin({ kind: "user", id: user.id }, "Only an admin can send a test alert.");
    if (!app.monitor) throw new AppError("internal", "This server runs no monitor.", 503);
    const metric = (req.query as { metric?: unknown }).metric;
    if (metric !== undefined && (typeof metric !== "string" || !app.monitor.keys().includes(metric))) {
      throw new AppError("bad_request", `metric must be one of: ${app.monitor.keys().join(", ")}`, 400);
    }
    return app.monitor.test(user.name, metric);
  });
}

function accessView(world: World, r: AccessRequest | null): AuthMe["accessRequest"] {
  return r ? { status: r.status, message: r.message, decidedAt: r.decidedAt, ...accessContext(world) } : null;
}

/** GET /api/health `desks`: the desk size new sessions get and today's desk bill against the town-wide cap (gr_uhh6u39vv9 step 3). */
function desksHealth(world: World) {
  const desks = world.desksConfig();
  const bill = world.deskBill();
  return { backend: desks.backend, size: deskPreset(deskSizeFor(desks, bill).size), billCapUsd: bill.capUsd, billTodayUsd: bill.todayUsd, billPct: bill.pct, overCap: bill.overCap, day: bill.day };
}
