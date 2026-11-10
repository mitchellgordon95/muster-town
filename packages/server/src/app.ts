import { CapacityProbe } from "./capacity.ts";
import { AppError, canInteract, countFunnel, countVisitor, DOORS, isAppError, isAutomatedClient, engagement, townHealth, joinFunnel, sumFunnels, type World } from "@muster-town/core";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { authRoutes, defaultAuthSettings, sessionAuth, type AuthSettings } from "./auth/index.ts";
import { townEnv } from "@muster-town/schema";
import { ASK_FIRST, bearer, INTERACT_ALLOWLIST, interactingUser, parse, requireUser, resolveToken, WEB_BASE, type RuntimeHooks } from "./context.ts";
import { collectives, renderHome, renderRetired } from "./home.ts";
import { CreateCollectiveInput, RenameCollectiveInput, type Hub } from "./hub.ts";
import type { BackupJob } from "./backup/index.ts";
import type { Directory } from "./directory/index.ts";
import { LoadMonitor } from "./load.ts";
import type { Monitor } from "./monitor.ts";
import { mcpRoutes } from "./mcp.ts";
import { agentRoutes } from "./routes/agents.ts";
import { deskRoutes } from "./routes/desk.ts";
import { directoryRoutes } from "./routes/directory.ts";
import { uptimeRoutes } from "./routes/uptime.ts";
import { Uptime } from "./uptime.ts";
import { docRoutes } from "./routes/docs.ts";
import { goalRoutes } from "./routes/goals.ts";
import { askRoutes } from "./routes/asks.ts";
import { grantRoutes } from "./routes/grants.ts";
import { mediaRoutes } from "./routes/media.ts";
import { secretRoutes } from "./routes/secrets.ts";
import { skillRoutes } from "./routes/skills.ts";
import { townRoutes } from "./routes/town.ts";
import { verbRoutes } from "./routes/verbs.ts";
import { wsRoutes } from "./ws.ts";

export const DEFAULT_WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
/** The Muster Town skill a stranger's own agent reads (served at `/skill.md`, so no repo clone is needed). */
const SKILL_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills/muster-town/SKILL.md");

export interface BuildAppOptions {
  world: World;
  /** enables `GET /api/dev/admin-token` and open CORS */
  dev?: boolean;
  runtime?: RuntimeHooks | null;
  /** built web client to serve under `WEB_BASE` (default packages/web/dist; skipped if missing; `false` disables) */
  webDist?: string | false;
  logger?: boolean;
  /** sign-in settings (GitHub OAuth, session secret, admin allowlist); default: no GitHub, per-process secret */
  auth?: Partial<AuthSettings>;
  /** this server's collective (its dir name, e.g. `workshop`): its homepage entry's slug */
  collective?: string;
  /** the hosted collectives (`hub.ts`): listed on the homepage and served at `/<slug>/` by this app; root app only */
  hub?: Hub | null;
  /** a hosted collective's app: every route under `/<slug>` (no homepage); "" or unset = the Workshop at the root */
  prefix?: string;
  /** where `POST /api/export` writes (default env MUSTER_TOWN_EXPORT): a hosted collective's own export dir */
  exportDir?: string;
  /** the off-site backup job (main.ts builds and starts it); `GET /api/health` shows its state as `backup` */
  backup?: BackupJob | null;
  /** the in-process monitor (main.ts builds and starts it, root app only); `GET /api/health` shows it as `monitor` */
  monitor?: Monitor | null;
  /** the self-hosted towns directory (main.ts builds it where MUSTER_TOWN_DIRECTORY=on; root app only): `/api/directory*` */
  directory?: Directory | null;
  /** a hosted collective's app: retire it (main.ts passes the hub's); `POST /<slug>/api/collective/retire`, its admins */
  retire?: (() => unknown) | null;
  /** a hosted collective's app: rename it, slug untouched (main.ts passes the hub's); `PATCH /<slug>/api/collective`, its admins */
  rename?: ((input: RenameCollectiveInput) => { name: string }) | null;
  /** recompute `GET /api/health`'s database-backed figures this often and serve the cached copy (main.ts: 5000); 0 = per request (tests) */
  healthRefreshMs?: number;
  /** MUSTER_TOWN_RUNTIME=off (throwaway.ts): a drill town; `GET /api/health` says `throwaway: true` */
  throwaway?: boolean;
}

const API_PREFIXES = ["/api", "/ws", "/mcp", "/auth"];
/** Active hosted collectives one GitHub user may own (a town admin: no cap). */
const HOSTED_PER_PERSON = 1;

/** The Fastify app (not listening). Tests use `app.inject`; `main.ts` calls `listen`. */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024 });
  app.decorate("world", opts.world);
  app.decorate("runtime", opts.runtime ?? null);
  app.decorate("dev", !!opts.dev);
  const load = new LoadMonitor();
  app.decorate("load", load);
  app.decorate("backup", opts.backup ?? null);
  app.decorate("throwaway", !!opts.throwaway);
  app.decorate("monitor", opts.monitor ?? null);
  app.decorate("hub", opts.hub ?? null);
  app.decorate("directory", !opts.prefix ? opts.directory ?? null : null);
  app.decorate("exportDir", opts.exportDir ?? null);
  app.decorate("healthRefreshMs", opts.healthRefreshMs ?? 0);
  // GET /api/health `capacity` (gr_n0p3ast5pp step 3): the root app only, hosted collectives share the process
  app.decorate("capacity", !opts.prefix ? new CapacityProbe(opts.world, { ws: () => load.snapshot().wsClients, tick: () => app.runtime?.tickStats?.().last }) : null);
  app.decorateRequest("auth", null);
  const authSettings = defaultAuthSettings(opts.auth);
  const prefix = opts.prefix ?? "";
  const webBase = prefix ? `${prefix}/` : WEB_BASE;

  await app.register(cors, { origin: opts.dev ? true : false });
  await app.register(websocket);

  const dist = opts.webDist === false ? null : opts.webDist ?? DEFAULT_WEB_DIST;
  const haveWeb = !!dist && existsSync(join(dist, "index.html"));
  // a hosted collective's URL (`/<slug>/…`, WebSocket upgrades too) goes to its own app before any Workshop hook runs
  const hub = opts.hub;
  if (hub) {
    app.addHook("onRequest", async (req, reply) => {
      const hosted = hub.match(req.url);
      if (!hosted) {
        // a retired collective keeps its address: a notice, never another collective or the Workshop's client
        const gone = hub.retiredAt(req.url);
        if (!gone) {
          // a collective's name typed as spelled (muster.town/Hollyville) lands on its lowercase address
          const to = req.headers.upgrade ? null : hub.caseRedirect(req.url);
          if (to) return reply.redirect(to, 301);
          return;
        }
        const api = /^\/[^/]+\/(api|ws|mcp|auth)(\/|$|\?)/.test(req.url);
        if (api) return reply.code(410).send({ error: `${gone.name} (/${gone.slug}/) was retired.`, code: "gone" });
        return reply.code(410).type("text/html; charset=utf-8").send(renderRetired(gone, haveWeb ? dist : null));
      }
      reply.hijack();
      hosted.routing(req.raw, reply.raw);
    });
  }

  // A redeploy restarting the server (docs/architecture.md "Redeploy"): desk and MCP calls that arrive once it is exiting get 503
  // `{ restarting: true }` with Retry-After (the desk resends them after the restart: they never ran); calls already
  // running are let finish, bounded (`world.host.quiesce`).
  const deskCall = (url: string) => url === `${prefix}/mcp` || url.startsWith(`${prefix}/mcp?`) || url.startsWith(`${prefix}/api/agents/me/`);
  let quiescing = false;
  let inFlight = 0;
  app.addHook("onRequest", async (req, reply) => {
    if (!deskCall(req.url)) return;
    if (quiescing) return reply.code(503).header("retry-after", "5").send({ error: "The town is restarting; retry in a few seconds.", code: "restarting", restarting: true });
    inFlight++;
    let done = false;
    const end = () => { if (!done) { done = true; inFlight--; } };
    req.raw.once("close", end);
    reply.raw.once("close", end);
  });
  if (!opts.prefix) {
    opts.world.host.quiesce = async (ms: number) => {
      quiescing = true;
      const until = Date.now() + ms;
      while (inFlight > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    };
  }

  app.addHook("onRequest", async (req) => {
    // bearer token first, then the browser session cookie
    req.auth = resolveToken(opts.world, bearer(req.headers.authorization)) ?? sessionAuth(opts.world, authSettings, req);
  });

  // One gate for every write (dc_f0cumcfubk): a user, or an agent acting for one, needs `town.interact`. GETs never.
  app.addHook("preHandler", async (req) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    const userId = interactingUser(opts.world, req.auth);
    if (!userId || canInteract(opts.world, userId)) return;
    if (INTERACT_ALLOWLIST.has(`${req.method} ${(req.routeOptions.url ?? req.url.split("?")[0]).slice(prefix.length)}`)) return;
    throw new AppError("forbidden", ASK_FIRST);
  });

  app.setErrorHandler((err, req, reply) => {
    if (isAppError(err)) return reply.code(err.status).send({ error: err.message, code: err.code, ...(err.permission ? { permission: err.permission } : {}) });
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), code: "bad_request" });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: (err as Error).message, code: status === 401 ? "unauthorized" : status === 404 ? "not_found" : "bad_request" });
    req.log.error({ err }, "[server] unhandled error");
    console.error("[server] unhandled error", err);
    return reply.code(500).send({ error: "Internal server error", code: "internal" });
  });

  const routes = async (c: FastifyInstance) => {
    await c.register(authRoutes(authSettings));
    await c.register(townRoutes);
    await c.register(deskRoutes);
    await c.register(agentRoutes);
    await c.register(docRoutes);
    await c.register(grantRoutes);
    await c.register(askRoutes);
    await c.register(goalRoutes);
    await c.register(mediaRoutes);
    await c.register(skillRoutes);
    await c.register(secretRoutes);
    await c.register(verbRoutes);
    await c.register(wsRoutes);
    await c.register(mcpRoutes);
  };
  if (prefix && opts.retire) {
    const retire = opts.retire;
    app.post(`${prefix}/api/collective/retire`, async (req) => {
      const user = requireUser(req);
      opts.world.permissions.requireAdmin({ kind: "user", id: user.id }, "Only an admin of this collective can retire it.");
      retire();
      return { retired: true, url: "/" };
    });
  }
  if (prefix && opts.rename) {
    const rename = opts.rename;
    app.patch(`${prefix}/api/collective`, async (req) => {
      const user = requireUser(req);
      opts.world.permissions.requireAdmin({ kind: "user", id: user.id }, "Only an admin of this collective can rename it.");
      const row = rename(parse(RenameCollectiveInput, req.body));
      return { collective: { name: row.name, slug: prefix.slice(1), url: `${prefix}/` } };
    });
  }
  if (prefix) await app.register(routes, { prefix });
  else await routes(app);
  // an ask's `api` claim check reads the town's own API in-process, signed out (core ask-checks.ts), never over the network
  opts.world.host.apiGet = async (path) => {
    const r = await app.inject({ method: "GET", url: `${prefix}${path}` });
    let body: unknown = r.body;
    try { body = r.json(); } catch { /* not JSON: the raw text */ }
    return { status: r.statusCode, body };
  };

  // The join funnel (grant gr_fibsfwr4tz step 3; `acted`, a let-in member's first Say or 1:1 line: gr_58n37j410s step 3): public counts only, never who. The guest card pings `view` once per load
  // (with the browser's random id: `guestVisitors` counts it once per UTC day; gr_zoo2cf2zpp); the homepage pings `home` the same way (the root only).
  // Our own headless checks and scripts never count. The root's GET also lists every hosted collective, so their strangers are rows too.
  const visitorOf = (body: unknown) => typeof body === "object" && body && typeof (body as { visitor?: unknown }).visitor === "string" ? (body as { visitor: string }).visitor : null;
  app.post(`${prefix}/api/join-funnel/view`, async (req) => {
    if (isAutomatedClient(req.headers["user-agent"])) return { counted: false };
    countFunnel(opts.world, "guestCardViews");
    const v = visitorOf(req.body);
    return { counted: true, visitor: v ? countVisitor(opts.world, "guestVisitors", v) : false };
  });
  if (!prefix) app.post("/api/join-funnel/home", async (req) => {
    if (isAutomatedClient(req.headers["user-agent"])) return { counted: false };
    const v = visitorOf(req.body);
    return { counted: !!v && countVisitor(opts.world, "homeViews", v) };
  });
  // the three doors (gr_y9bpvx197c): the guest card or You're-in card pings which door this browser opened, once per door per UTC day
  app.post(`${prefix}/api/join-funnel/door`, async (req) => {
    if (isAutomatedClient(req.headers["user-agent"])) return { counted: false };
    const door = typeof req.body === "object" && req.body ? (req.body as { door?: unknown }).door : null;
    const step = typeof door === "string" && Object.hasOwn(DOORS, door) ? DOORS[door as keyof typeof DOORS] : null;
    if (!step) throw new AppError("bad_request", "door must be fund, captain or agent");
    const v = visitorOf(req.body);
    return { counted: !!v && countVisitor(opts.world, step, v) };
  });
  app.get(`${prefix}/api/join-funnel`, async () => {
    const own = { slug: prefix ? prefix.slice(1) : opts.collective ?? "workshop", world: opts.world };
    const hosted = prefix ? [] : (opts.hub?.list("active") ?? []).flatMap((h) => { const w = opts.hub!.world(h.slug); return w ? [{ slug: h.slug, world: w }] : []; });
    const all = [own, ...hosted];
    const funnel = { ...sumFunnels(all.map((c) => c.world)), collectives: all.map((c) => ({ slug: c.slug, ...joinFunnel(c.world) })) };
    // the founder road (gr_ngg1z160a8 step 2): per hosted collective, dates only; the root's only
    return prefix ? funnel : { ...funnel, founders: opts.hub?.founderRoads() ?? [] };
  });

  // community engagement in this collective only (flag dc_r7u6bkaei4): what its signed-in humans did here, counts only
  app.get(`${prefix}/api/engagement`, async () => engagement(opts.world));
  // town health in this collective only (gr_8bxoy2heif): paperwork share, cache hits, overrun past holds, tokens per report; counts only
  app.get(`${prefix}/api/health-stats`, async () => townHealth(opts.world));

  // Serve the client dynamically (wildcard): a rebuild after startup must be served without a restart.
  // index.html is never cached so a stale page can't point at an asset hash that no longer exists.
  // a hosted collective serves the same client (its HTML still loads /workshop/assets/ from the root app)
  if (haveWeb) await app.register(fastifyStatic, { root: dist!, prefix: webBase, wildcard: true });
  // /workshop goes to /workshop/, query kept; browsers carry the #fragment across the redirect on their own
  const toWeb = async (req: FastifyRequest, reply: FastifyReply) => { const q = req.url.indexOf("?"); return reply.redirect(webBase + (q >= 0 ? req.url.slice(q) : "")); };
  app.get(webBase.slice(0, -1), toWeb);
  if (!prefix) {
    // the root is the collectives homepage. It takes no parameters, so a query (old `/?guest`, `/?as=`) still goes to the
    // client; old `/#/doc|grant/…` links are forwarded by the page's inline script (the server never sees the fragment)
    const list = () => collectives(opts.world, opts.hub?.listed() ?? [], opts.collective);
    app.get("/", async (req, reply) => {
      if (/\?./.test(req.url)) return toWeb(req, reply);
      return reply.type("text/html; charset=utf-8").send(renderHome(list(), haveWeb ? dist : null));
    });
    app.get("/api/collectives", async () => ({ collectives: list() }));
    // Start a collective (docs/hosted-collectives.md step 3): anyone signed in with GitHub, one active collective each;
    // a town admin has no cap (and may create one without GitHub, ownerless). The key is never in the reply.
    app.post("/api/collectives", async (req, reply) => {
      const user = requireUser(req);
      if (!opts.hub) throw new AppError("internal", "This server hosts no other collectives (no hub).", 503);
      const admin = opts.world.permissions.isUserAdmin(user.id);
      const owner = user.githubId != null && user.githubLogin ? { id: user.githubId, login: user.githubLogin, name: user.name, avatarUrl: user.avatarUrl ?? null } : null;
      if (!owner && !admin) throw new AppError("forbidden", "Sign in with GitHub to start a collective.");
      if (owner && !admin) {
        const mine = opts.hub.ownedBy(owner.id);
        if (mine.length >= HOSTED_PER_PERSON) throw new AppError("rate_limited", `You already run muster.town/${mine[0]!.slug}/: one collective per person for now. Retire it there (Planning desk, System) to start another.`);
      }
      const row = await opts.hub.create(parse(CreateCollectiveInput, req.body), owner);
      return reply.code(201).send({ collective: { ...row, url: `/${row.slug}/` } });
    });
    // the root's admins rename any hosted collective (its own admins do it at PATCH /<slug>/api/collective); the slug stays
    app.patch<{ Params: { slug: string } }>("/api/collectives/:slug", async (req) => {
      const user = requireUser(req);
      if (!opts.hub) throw new AppError("internal", "This server hosts no other collectives (no hub).", 503);
      opts.world.permissions.requireAdmin({ kind: "user", id: user.id }, "Only an admin of this town can rename another collective.");
      const row = opts.hub.rename(req.params.slug, parse(RenameCollectiveInput, req.body));
      return { collective: { ...row, url: `/${row.slug}/` } };
    });
    // A Workshop admin retires any hosted collective (Mitchell's flag dc_hz1nz88pkt: a test one someone else owns); the
    // same retire as its own admins' (hub row kept as 'retired', slug never reused, its dir and data stay on disk)
    app.post<{ Params: { slug: string } }>("/api/collectives/:slug/retire", async (req) => {
      const user = requireUser(req);
      opts.world.permissions.requireAdmin({ kind: "user", id: user.id }, "Only an admin of the Workshop can retire another collective.");
      if (!opts.hub) throw new AppError("not_found", "This server hosts no other collectives (no hub).");
      const row = opts.hub.retire(req.params.slug);
      return { collective: row };
    });
    // read per request, like the client: a pull shows without a restart
    app.get("/skill.md", async (_req, reply) => {
      if (!existsSync(SKILL_FILE)) return reply.code(404).send({ error: "Not found: GET /skill.md", code: "not_found" });
      return reply.type("text/markdown; charset=utf-8").header("cache-control", "no-cache").send(readFileSync(SKILL_FILE, "utf8"));
    });
    // every town: the token that proves this host to muster.town's directory (design dc_d6chojzl2a), read per request
    app.get("/.well-known/muster-town", async (_req, reply) => {
      const token = townEnv("DIRECTORY_TOKEN")?.trim();
      if (!token) return reply.code(404).send({ error: "Not found: GET /.well-known/muster-town (MUSTER_TOWN_DIRECTORY_TOKEN is not set)", code: "not_found" });
      return reply.type("text/plain; charset=utf-8").header("cache-control", "no-cache").send(token);
    });
    if (opts.directory) await app.register(directoryRoutes(opts.directory));
    // public uptime from outside probes (gr_rcj8nkbkbt): every root town; empty until a pinger posts
    await app.register(uptimeRoutes(new Uptime(opts.world)));
  }
  // the monitor's 5xx share (monitor.ts Counters); hosted collectives' requests are hijacked above and not counted
  if (opts.monitor) { const c = opts.monitor.counters; app.addHook("onResponse", async (_req, reply) => { c.response(reply.statusCode); }); }

  // never let a browser cache the page itself: a stale index.html would point at asset hashes that no longer exist
  app.addHook("onSend", async (_req, reply, payload) => {
    const ct = String(reply.getHeader("content-type") ?? "");
    if (ct.startsWith("text/html")) reply.header("cache-control", "no-cache");
    return payload;
  });

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0];
    const isApi = API_PREFIXES.some((p) => path === prefix + p || path.startsWith(prefix + p + "/"));
    // a missing built asset is a real 404 (never index.html as JavaScript); only extension-less paths are SPA routes
    const looksLikeFile = /\.[a-z0-9]{1,8}$/i.test(path.split("/").pop() ?? "");
    if (haveWeb && !isApi && !looksLikeFile && (req.method === "GET" || req.method === "HEAD")) {
      // SPA routes only under the client's prefix; any other page path goes to the root
      if (!path.startsWith(webBase)) return reply.redirect("/");
      reply.header("cache-control", "no-cache");
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: `Not found: ${req.method} ${path}`, code: "not_found" });
  });

  app.addHook("onClose", async () => { load.close(); app.backup?.stop(); app.monitor?.stop(); app.directory?.stop(); await opts.hub?.close(); await (opts.runtime?.close?.() ?? opts.runtime?.stop?.()); });
  return app;
}
