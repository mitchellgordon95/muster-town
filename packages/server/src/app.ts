import { isAppError, type World } from "@muster-town/core";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { authRoutes, defaultAuthSettings, sessionAuth, type AuthSettings } from "./auth/index.ts";
import { bearer, resolveToken, WEB_BASE, type RuntimeHooks } from "./context.ts";
import { collectives, DEFAULT_REGISTRY, renderHome } from "./home.ts";
import { LoadMonitor } from "./load.ts";
import { mcpRoutes } from "./mcp.ts";
import { agentRoutes } from "./routes/agents.ts";
import { deskRoutes } from "./routes/desk.ts";
import { docRoutes } from "./routes/docs.ts";
import { grantRoutes } from "./routes/grants.ts";
import { secretRoutes } from "./routes/secrets.ts";
import { skillRoutes } from "./routes/skills.ts";
import { townRoutes } from "./routes/town.ts";
import { verbRoutes } from "./routes/verbs.ts";
import { wsRoutes } from "./ws.ts";

export const DEFAULT_WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");

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
  /** the collectives listed on the homepage (default collectives/registry.json; read per request) */
  registry?: string;
}

const API_PREFIXES = ["/api", "/ws", "/mcp", "/auth"];

/** The Fastify app (not listening). Tests use `app.inject`; `main.ts` calls `listen`. */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024 });
  app.decorate("world", opts.world);
  app.decorate("runtime", opts.runtime ?? null);
  app.decorate("dev", !!opts.dev);
  const load = new LoadMonitor();
  app.decorate("load", load);
  app.decorateRequest("auth", null);
  const authSettings = defaultAuthSettings(opts.auth);

  await app.register(cors, { origin: opts.dev ? true : false });
  await app.register(websocket);

  app.addHook("onRequest", async (req) => {
    // bearer token first, then the browser session cookie
    req.auth = resolveToken(opts.world, bearer(req.headers.authorization)) ?? sessionAuth(opts.world, authSettings, req);
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

  await app.register(authRoutes(authSettings));
  await app.register(townRoutes);
  await app.register(deskRoutes);
  await app.register(agentRoutes);
  await app.register(docRoutes);
  await app.register(grantRoutes);
  await app.register(skillRoutes);
  await app.register(secretRoutes);
  await app.register(verbRoutes);
  await app.register(wsRoutes);
  await app.register(mcpRoutes);

  const dist = opts.webDist === false ? null : opts.webDist ?? DEFAULT_WEB_DIST;
  const haveWeb = !!dist && existsSync(join(dist, "index.html"));
  // Serve the client dynamically (wildcard): a rebuild after startup must be served without a restart.
  // index.html is never cached so a stale page can't point at an asset hash that no longer exists.
  if (haveWeb) await app.register(fastifyStatic, { root: dist!, prefix: WEB_BASE, wildcard: true });
  // /workshop goes to /workshop/, query kept; browsers carry the #fragment across the redirect on their own
  const toWeb = async (req: FastifyRequest, reply: FastifyReply) => { const q = req.url.indexOf("?"); return reply.redirect(WEB_BASE + (q >= 0 ? req.url.slice(q) : "")); };
  app.get(WEB_BASE.slice(0, -1), toWeb);
  // the root is the collectives homepage. It takes no parameters, so a query (old `/?guest`, `/?as=`) still goes to the
  // client; old `/#/doc|grant/…` links are forwarded by the page's inline script (the server never sees the fragment)
  const registry = opts.registry ?? DEFAULT_REGISTRY;
  app.get("/", async (req, reply) => {
    if (/\?./.test(req.url)) return toWeb(req, reply);
    return reply.type("text/html; charset=utf-8").send(renderHome(collectives(opts.world, registry), haveWeb ? dist : null));
  });
  app.get("/api/collectives", async () => ({ collectives: collectives(opts.world, registry) }));
  // never let a browser cache the page itself: a stale index.html would point at asset hashes that no longer exist
  app.addHook("onSend", async (_req, reply, payload) => {
    const ct = String(reply.getHeader("content-type") ?? "");
    if (ct.startsWith("text/html")) reply.header("cache-control", "no-cache");
    return payload;
  });

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0];
    const isApi = API_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
    // a missing built asset is a real 404 (never index.html as JavaScript); only extension-less paths are SPA routes
    const looksLikeFile = /\.[a-z0-9]{1,8}$/i.test(path.split("/").pop() ?? "");
    if (haveWeb && !isApi && !looksLikeFile && (req.method === "GET" || req.method === "HEAD")) {
      // SPA routes only under the client's prefix; any other page path goes to the root
      if (!path.startsWith(WEB_BASE)) return reply.redirect("/");
      reply.header("cache-control", "no-cache");
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: `Not found: ${req.method} ${path}`, code: "not_found" });
  });

  app.addHook("onClose", async () => { load.close(); await (opts.runtime?.close?.() ?? opts.runtime?.stop?.()); });
  return app;
}
