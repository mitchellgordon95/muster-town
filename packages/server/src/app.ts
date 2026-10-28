import { AppError, canInteract, isAppError, type World } from "@muster-town/core";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { authRoutes, defaultAuthSettings, sessionAuth, type AuthSettings } from "./auth/index.ts";
import { ASK_FIRST, bearer, INTERACT_ALLOWLIST, interactingUser, parse, requireUser, resolveToken, WEB_BASE, type RuntimeHooks } from "./context.ts";
import { collectives, renderHome, renderRetired } from "./home.ts";
import { CreateCollectiveInput, type Hub } from "./hub.ts";
import type { BackupJob } from "./backup/index.ts";
import { LoadMonitor } from "./load.ts";
import type { Monitor } from "./monitor.ts";
import { mcpRoutes } from "./mcp.ts";
import { agentRoutes } from "./routes/agents.ts";
import { deskRoutes } from "./routes/desk.ts";
import { docRoutes } from "./routes/docs.ts";
import { grantRoutes } from "./routes/grants.ts";
import { mediaRoutes } from "./routes/media.ts";
import { secretRoutes } from "./routes/secrets.ts";
import { skillRoutes } from "./routes/skills.ts";
import { townRoutes } from "./routes/town.ts";
import { verbRoutes } from "./routes/verbs.ts";
import { wsRoutes } from "./ws.ts";

export const DEFAULT_WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
/** The Muster Town skill a stranger's own agent reads (served at `/skill.md`, so no repo clone is needed). */
export const SKILL_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills/muster-town/SKILL.md");

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
  /** a hosted collective's app: retire it (main.ts passes the hub's); `POST /<slug>/api/collective/retire`, its admins */
  retire?: (() => unknown) | null;
}

const API_PREFIXES = ["/api", "/ws", "/mcp", "/auth"];
/** Active hosted collectives one GitHub user may own (a town admin: no cap). */
export const HOSTED_PER_PERSON = 1;

/** The Fastify app (not listening). Tests use `app.inject`; `main.ts` calls `listen`. */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024 });
  app.decorate("world", opts.world);
  app.decorate("runtime", opts.runtime ?? null);
  app.decorate("dev", !!opts.dev);
  const load = new LoadMonitor();
  app.decorate("load", load);
  app.decorate("backup", opts.backup ?? null);
  app.decorate("monitor", opts.monitor ?? null);
  app.decorate("hub", opts.hub ?? null);
  app.decorate("exportDir", opts.exportDir ?? null);
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
        if (!gone) return;
        const api = /^\/[^/]+\/(api|ws|mcp|auth)(\/|$|\?)/.test(req.url);
        if (api) return reply.code(410).send({ error: `${gone.name} (/${gone.slug}/) was retired.`, code: "gone" });
        return reply.code(410).type("text/html; charset=utf-8").send(renderRetired(gone, haveWeb ? dist : null));
      }
      reply.hijack();
      hosted.routing(req.raw, reply.raw);
    });
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
      if (!opts.world.permissions.isAdmin({ kind: "user", id: user.id })) throw new AppError("forbidden", "Only an admin of this collective can retire it.");
      retire();
      return { retired: true, url: "/" };
    });
  }
  if (prefix) await app.register(routes, { prefix });
  else await routes(app);

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
    const list = () => collectives(opts.world, opts.hub?.list("active") ?? [], opts.collective);
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
      const admin = opts.world.permissions.isAdmin({ kind: "user", id: user.id });
      const owner = user.githubId != null && user.githubLogin ? { id: user.githubId, login: user.githubLogin, name: user.name, avatarUrl: user.avatarUrl ?? null } : null;
      if (!owner && !admin) throw new AppError("forbidden", "Sign in with GitHub to start a collective.");
      if (owner && !admin) {
        const mine = opts.hub.ownedBy(owner.id);
        if (mine.length >= HOSTED_PER_PERSON) throw new AppError("rate_limited", `You already run muster.town/${mine[0]!.slug}/: one collective per person for now. Retire it there (Planning desk, System) to start another.`);
      }
      const row = await opts.hub.create(parse(CreateCollectiveInput, req.body), owner);
      return reply.code(201).send({ collective: { ...row, url: `/${row.slug}/` } });
    });
    // read per request, like the client: a pull shows without a restart
    app.get("/skill.md", async (_req, reply) => {
      if (!existsSync(SKILL_FILE)) return reply.code(404).send({ error: "Not found: GET /skill.md", code: "not_found" });
      return reply.type("text/markdown; charset=utf-8").header("cache-control", "no-cache").send(readFileSync(SKILL_FILE, "utf8"));
    });
  }
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

  app.addHook("onClose", async () => { load.close(); app.backup?.stop(); app.monitor?.stop(); await opts.hub?.close(); await (opts.runtime?.close?.() ?? opts.runtime?.stop?.()); });
  return app;
}
