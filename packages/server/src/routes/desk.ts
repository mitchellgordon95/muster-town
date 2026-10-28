/**
 * Agent-scoped API for desks (bearer **agent** token): the process inside an agent's container fetches its
 * brief, streams activity, polls control (interrupts + stop), and reports the end of its work session.
 */
import { AppError, TRANSCRIPT_MAX_UPLOAD, composeWorkBrief } from "@muster-town/core";
import { DeskActivityInput, DeskControlAckInput, DeskSessionEndInput, type Agent, type DeskControl, type Session } from "@muster-town/schema";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse, requireAuth } from "../context.ts";

const SessionQuery = z.object({ session: z.string().min(1) });

function requireAgent(req: FastifyRequest): Agent {
  const a = requireAuth(req);
  if (a.kind !== "agent") throw new AppError("forbidden", "This endpoint needs an agent token.");
  return a.agent;
}

export async function deskRoutes(app: FastifyInstance) {
  const world = app.world;
  app.addContentTypeParser("application/x-brotli", { parseAs: "buffer", bodyLimit: TRANSCRIPT_MAX_UPLOAD + 1024 }, (_req, body, done) => done(null, body));

  /** The caller's session, or 403 (unknown sessions are 403 too: don't leak ids). */
  const ownSession = (agent: Agent, sessionId: string, needRunning: boolean): Session => {
    const s = world.sessions.get(sessionId);
    if (!s || s.agentId !== agent.id) throw new AppError("forbidden", "Not your session.");
    if (needRunning && s.status !== "running") throw new AppError("forbidden", `Session ${s.id} is ${s.status}.`);
    return s;
  };

  app.get("/api/agents/me/brief", async (req) => {
    const agent = requireAgent(req);
    const { session } = parse(SessionQuery, req.query);
    ownSession(agent, session, true);
    return composeWorkBrief(world, session);
  });

  app.post("/api/agents/me/activity", async (req, reply) => {
    const agent = requireAgent(req);
    const input = parse(DeskActivityInput, req.body);
    const s = ownSession(agent, input.session, false);
    if (s.status !== "running") throw new AppError("conflict", `Session ${s.id} is ${s.status}.`);
    if (app.runtime?.onDeskActivity) {
      await app.runtime.onDeskActivity(agent.id, input);
    } else {
      // no runtime attached: record plainly so the transcript isn't lost
      const text = input.kind === "tool" ? `Using ${input.tool ?? "a tool"}` : (input.text ?? "").slice(0, 200);
      const type = input.kind === "tool" ? "agent.tool" : input.kind === "thought" ? "agent.thought" : "agent.activity";
      if (text.trim()) world.events.append({ type, agentId: agent.id, buildingId: agent.homeBuildingId ?? agent.buildingId, text, payload: { sessionId: s.id, purpose: s.purpose, ...(input.tool ? { tool: input.tool } : {}) } });
    }
    return reply.code(204).send();
  });

  app.get("/api/agents/me/control", async (req): Promise<DeskControl> => {
    const agent = requireAgent(req);
    const { session } = parse(SessionQuery, req.query);
    const s = ownSession(agent, session, false);
    if (s.status === "running") app.runtime?.deskSeen?.(agent.id, s.id);
    const now = world.agents.require(agent.id, "agent");
    const stop = s.status !== "running" || now.status === "stopped" || now.status === "banned" || now.status === "retired";
    return { interrupts: world.ops.pendingInterrupts(agent.id, s.id).map((i) => ({ id: i.id, text: i.text, from: i.from, now: i.now })), stop };
  });

  app.post("/api/agents/me/control/ack", async (req, reply) => {
    const agent = requireAgent(req);
    const { ids } = parse(DeskControlAckInput, req.body);
    world.ops.ackInterrupts(ids, agent.id);
    return reply.code(204).send();
  });

  app.post("/api/agents/me/session-end", async (req) => {
    const agent = requireAgent(req);
    const input = parse(DeskSessionEndInput, req.body);
    const s = ownSession(agent, input.session, false);
    if (s.status !== "running") return { session: s };
    if (!app.runtime?.finishWorkSession) throw new AppError("internal", "runtime not available", 503);
    const { session: _id, ...outcome } = input;
    const session = await app.runtime.finishWorkSession(s.id, outcome);
    return { session };
  });

  /**
   * The session's SDK transcript (docs/transcripts.md): the brotli of the JSONL the Agent SDK wrote, as the raw body
   * (Content-Type application/x-brotli). The desk sends it just before session-end; a later upload replaces it.
   */
  app.post("/api/agents/me/transcript", async (req, reply) => {
    const agent = requireAgent(req);
    const { session } = parse(SessionQuery, req.query);
    const s = ownSession(agent, session, false);
    if (!Buffer.isBuffer(req.body)) throw new AppError("bad_request", "Send the brotli JSONL as the raw body with Content-Type application/x-brotli.");
    const transcript = world.transcripts.put(s, req.body, { compressed: true, source: "desk" });
    return reply.code(201).send({ transcript });
  });
}
