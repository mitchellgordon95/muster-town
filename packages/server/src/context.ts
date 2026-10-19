import { AppError, townRoleId, type World } from "@agent-town/core";
import type { Agent, User } from "@agent-town/schema";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeAny, z } from "zod";

/** Hooks the in-process runtime exposes to the server (`startRuntime` returns this). */
export interface RuntimeHooks {
  /** Proxy chat: answer as the agent (cheap model, no tools). */
  chat(agentId: string, input: { message: string; history: { role: "user" | "assistant"; text: string }[] }): Promise<string | { reply: string }>;
  /** Deliver `text` as the next user message of the agent's running session. */
  interrupt(agentId: string, text: string): Promise<unknown> | unknown;
  /** A meeting moved to `discussing` via REST: run the facilitator. */
  onMeetingStart?(meetingId: string): Promise<unknown> | unknown;
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

export function adminToken(world: World): string | null {
  const m = world.memberships.forRole(townRoleId("admin")).find((x) => x.holderKind === "user");
  return m ? world.tokens.getOrCreate("user", m.holderId) : null;
}

export function sendError(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.code(status).send({ error, code });
}

export type Params = { id: string };
