/**
 * v1.4 generic verbs endpoint: the MCP tools over plain HTTP, for clients that aren't MCP (the `agent-town` CLI).
 *
 * - `GET /api/verbs` (no auth needed) → `{ verbs: [{ name, description, inputSchema }] }` (JSON Schema from the Zod inputs).
 * - `POST /api/verbs/:verb` (agent token) with the verb's input as the JSON body → 200 `{ result }`, or
 *   `{ error, code }` with the usual status mapping (400 bad input, 401 no/unknown token, 403 user token or not
 *   allowed, 404 unknown verb or missing object, 409 conflict, …).
 * - `GET /api/agents/me/digest[?since=<iso>]` (agent token) → the mailbox digest of the last offline window (or since
 *   `since`), or `null` when there is none.
 *
 * Every call here and every MCP tool call goes through `runVerb`, so both paths stamp presence and run the same code.
 */
import { AppError, type World } from "@agent-town/core";
import { MailboxDigest, VERB_DESCRIPTIONS, VERB_NAMES, VerbInputs, toJsonSchema, type Agent, type VerbListing, type VerbName } from "@agent-town/schema";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse, requireAuth } from "../context.ts";

/** Stamp presence for the caller, then run the verb as it (input parsed and validated by `world.verbs`). */
export async function runVerb(world: World, agentId: string, name: VerbName, input: unknown): Promise<unknown> {
  world.presence.touch(agentId);
  const run = world.verbs[name] as (actor: string, input: unknown) => Promise<unknown>;
  return run(agentId, input ?? {});
}

export function verbListing(): VerbListing[] {
  return VERB_NAMES.map((name) => ({ name, description: VERB_DESCRIPTIONS[name], inputSchema: toJsonSchema(VerbInputs[name]) }));
}

function requireAgentToken(req: FastifyRequest): Agent {
  const a = requireAuth(req);
  if (a.kind !== "agent") throw new AppError("forbidden", "This endpoint needs an agent token (Authorization: Bearer <agent token>), not a user token.");
  return a.agent;
}

const isVerb = (v: string): v is VerbName => (VERB_NAMES as string[]).includes(v);

export async function verbRoutes(app: FastifyInstance) {
  const world = app.world;
  const listing = verbListing();

  app.get("/api/verbs", async () => ({ verbs: listing }));

  app.post<{ Params: { verb: string } }>("/api/verbs/:verb", async (req) => {
    const agent = requireAgentToken(req);
    const verb = req.params.verb;
    if (!isVerb(verb)) throw new AppError("not_found", `Unknown verb: ${verb}. GET /api/verbs lists them.`);
    return { result: (await runVerb(world, agent.id, verb, req.body ?? {})) ?? null };
  });

  app.get("/api/agents/me/digest", async (req, reply): Promise<MailboxDigest | null> => {
    const agent = requireAgentToken(req);
    const { since } = parse(z.object({ since: z.string().datetime({ offset: true }).optional() }), req.query);
    world.presence.touch(agent.id);
    const d = world.presence.lastDigest(agent.id, since ? new Date(since).toISOString() : undefined);
    return reply.type("application/json").send(JSON.stringify(d));
  });
}
