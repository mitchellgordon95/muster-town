import { AppError, canInteract, townRoleId, type World } from "@muster-town/core";
import type { Agent, DeskActivityInput, RedeployResult, Session, TokenCounts, User } from "@muster-town/schema";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeAny, z } from "zod";
import type { BackupJob } from "./backup/index.ts";
import type { Hub } from "./hub.ts";
import type { LoadMonitor } from "./load.ts";
import type { Monitor } from "./monitor.ts";

/** Hooks the in-process runtime exposes to the server (`startRuntime` returns this). */
/** where the web client is served (Vite `base`); `/` is the collectives homepage (`home.ts`) */
export const WEB_BASE = "/workshop/";

export interface RuntimeHooks {
  /** Proxy chat: answer as the agent (cheap model, no tools). */
  chat(agentId: string, input: { message: string; history: { role: "user" | "assistant"; text: string }[] }): Promise<string | { reply: string }>;
  /** Ask about a report without its author: cheap model over the report body, the author's recent events, and the building's goal/rules. */
  askAbout?(docId: string, question: string, userId: string, history?: { role: "user" | "assistant"; text: string }[]): Promise<string | { reply: string }>;
  /** Deliver `text` as the next user message of the agent's in-process session. `false` = none (the server queues it). */
  interrupt(agentId: string, text: string, from?: string, now?: boolean): Promise<unknown> | unknown;
  /** A desk reported activity: append `agent.tool`/`agent.thought`/`agent.activity` events (payload.sessionId). */
  onDeskActivity?(agentId: string, input: DeskActivityInput): Promise<unknown> | unknown;
  /** End a work session (desk session-end): fallback report, status, charge. Idempotent. */
  finishWorkSession?(sessionId: string, outcome: { tokens?: number; counts?: TokenCounts; byModel?: Record<string, TokenCounts>; costUsd?: number; turns?: number; sdkSessionId?: string | null; finalText?: string | null; error?: string | null; reportSubmitted?: boolean; fundingUsed?: NonNullable<Session["funding"]>; fallback?: boolean }): Promise<Session>;
  /** An agent was dismissed (core already retired it): abort its session, `docker rm -f` its desk (volume kept unless purge). */
  onAgentRetired?(agentId: string, opts?: { purge?: boolean }): Promise<unknown> | unknown;
  /** A meeting moved to `discussing` via REST: run the facilitator. */
  onMeetingStart?(meetingId: string): Promise<unknown> | unknown;
  /** v1.3: pull main, reinstall, rebuild, restart (exit 75) in the background. A request while one runs joins it (`{ queued: true }`). */
  redeploy?(o: { image: boolean; requestedBy: string }): Promise<RedeployResult> | RedeployResult;
  /** An agent was stopped via REST: abort its running session, if any. */
  stop?(): Promise<unknown> | unknown;
  /** Shut down timers/sessions. */
  close?(): Promise<unknown> | unknown;
}

/** Who made the request. */
export type Auth =
  | { kind: "user"; user: User }
  | { kind: "agent"; agent: Agent };

declare module "fastify" {
  interface FastifyInstance {
    world: World;
    runtime: RuntimeHooks | null;
    dev: boolean;
    /** event-loop lag, RSS and open WebSocket clients, for `GET /api/health` */
    load: LoadMonitor;
    /** the off-site backup job (null in tests and without one): `GET /api/health` `backup` */
    backup: BackupJob | null;
    /** the in-process monitor (null in tests and hosted collectives): `GET /api/health` `monitor`, `POST /api/admin/monitor/test` */
    monitor: Monitor | null;
    /** the hosted collectives (root app only; null in a hosted collective's app and without a hub) */
    hub: Hub | null;
    /** a hosted collective's export dir (null: env MUSTER_TOWN_EXPORT) */
    exportDir: string | null;
  }
  interface FastifyRequest {
    auth: Auth | null;
  }
}

export function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/** Resolve a bearer token to a user or agent (null if missing/unknown). */
export function resolveToken(world: World, token: string | null): Auth | null {
  if (!token) return null;
  const row = world.tokens.resolve(token);
  if (!row) return null;
  if (row.kind === "user") {
    const user = world.users.get(row.id);
    return user ? { kind: "user", user } : null;
  }
  const agent = world.agents.get(row.id);
  return agent ? { kind: "agent", agent } : null;
}

export function requireAuth(req: FastifyRequest): Auth {
  if (!req.auth) throw new AppError("unauthorized", "Missing or invalid bearer token.");
  return req.auth;
}

export function requireUser(req: FastifyRequest): User {
  const a = requireAuth(req);
  if (a.kind !== "user") throw new AppError("forbidden", "This endpoint needs a user token, not an agent token.");
  return a.user;
}

/** The agent that acts for this request: a user's avatar (permissions resolve to the user), or the agent itself. */
export function actorOf(world: World, req: FastifyRequest): Agent {
  const a = requireAuth(req);
  return a.kind === "user" ? world.ops.ensureAvatar(a.user.id) : world.agents.require(a.agent.id, "agent");
}

/** Holder id used for draft visibility ("" for anonymous). */
export function viewerId(req: FastifyRequest): string {
  const a = req.auth;
  if (!a) return "";
  return a.kind === "user" ? a.user.id : a.agent.id;
}

/** Parse with a schema; failures become 400 `{error, code: "bad_request"}`. */
export function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new AppError("bad_request", `Invalid input: ${msg}`);
  }
  return r.data;
}

/**
 * Who may interact (dc_f0cumcfubk): the user a request acts for (a user token, a human avatar, a bring-your-own
 * visitor agent), or null for residents and service agents, which the gate leaves alone.
 */
export function interactingUser(world: World, auth: Auth | null): string | null {
  if (!auth) return null;
  if (auth.kind === "user") return auth.user.id;
  const a = auth.agent;
  return (a.kind === "human" || a.kind === "visitor") && a.ownerUserId ? a.ownerUserId : null;
}

/** Writes a signed-in visitor may make before an admin lets them in. */
export const INTERACT_ALLOWLIST = new Set(["POST /auth/logout", "POST /api/auth/github/device", "POST /api/access-requests",
  // Start a collective (docs/hosted-collectives.md step 3): a stranger signed in with GitHub, before anyone lets them in
  "POST /api/collectives"]);
export const ASK_FIRST = "Ask for access first: you can watch and read, but taking part needs an admin to let you in (Ask to join on the guest card).";

export function adminToken(world: World): string | null {
  const m = world.memberships.forRole(townRoleId("admin")).find((x) => x.holderKind === "user");
  return m ? world.tokens.getOrCreate("user", m.holderId) : null;
}

export function sendError(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.code(status).send({ error, code });
}

export type Params = { id: string };
