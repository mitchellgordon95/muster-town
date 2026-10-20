import { AppError, type World } from "@agent-town/core";
import { ChatInput, CreateResidentInput, Event, InterruptInput, MessageAgentInput, RegisterVisitorInput, WorkInput, type Session } from "@agent-town/schema";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, parse, requireAuth, requireUser, type Params } from "../context.ts";

/** Events belonging to a session: the agent's events between its start and end. */
function sessionTranscript(world: World, s: Session): Event[] {
  const rows = world.db.prepare(
    "SELECT * FROM events WHERE agentId = ? AND ts >= ? AND (? IS NULL OR ts <= ?) ORDER BY id ASC LIMIT 2000",
  ).all(s.agentId, s.startedAt, s.endedAt, s.endedAt) as Record<string, unknown>[];
  return rows.map((r) => Event.parse({ ...r, payload: JSON.parse(String(r.payload ?? "{}")) }));
}

function runtimeOr503(app: FastifyInstance) {
  if (!app.runtime) throw new AppError("internal", "runtime not available", 503);
  return app.runtime;
}

export async function agentRoutes(app: FastifyInstance) {
  const world = app.world;

  app.post("/api/agents/residents", async (req, reply) => {
    const input = parse(CreateResidentInput, req.body);
    const agent = world.ops.createResident(actorOf(world, req), input);
    return reply.code(201).send({ agent });
  });

  app.post("/api/agents/visitors", async (req, reply) => {
    const user = requireUser(req);
    const input = parse(RegisterVisitorInput, req.body);
    const { agent, token } = world.ops.registerVisitor(user.id, input);
    return reply.code(201).send({ agent, token });
  });

  app.get<{ Params: Params }>("/api/agents/:id", async (req) => {
    const agent = world.agents.require(req.params.id, "agent");
    return {
      agent,
      recentEvents: world.events.recent({ agentId: agent.id, limit: 50 }),
      currentSession: world.ops.currentSession(agent.id) ?? null,
      latestReport: world.docs.first("type = 'report' AND authorId = ?", [agent.id], "ORDER BY createdAt DESC, rowid DESC") ?? null,
      // active, then the queue in run order, then history newest first
      assignments: world.assignments.where("agentId = ?", [agent.id],
        "ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, CASE WHEN status = 'pending' THEN position END, updatedAt DESC, rowid DESC LIMIT 50"),
    };
  });

  app.get<{ Params: Params }>("/api/agents/:id/session", async (req) => {
    const agent = world.agents.require(req.params.id, "agent");
    const session = world.ops.currentSession(agent.id) ?? null;
    return { session, transcript: session ? sessionTranscript(world, session) : [] };
  });

  app.post<{ Params: Params }>("/api/agents/:id/work", async (req, reply) => {
    const input = parse(WorkInput, req.body);
    const assignment = world.ops.createWork(actorOf(world, req), req.params.id, input);
    return reply.code(201).send({ assignment });
  });

  app.post<{ Params: Params }>("/api/agents/:id/interrupt", async (req) => {
    const { text, now = false } = parse(InterruptInput, req.body);
    const agent = world.agents.require(req.params.id, "agent");
    const actor = actorOf(world, req);
    world.ops.requireAgentControl(actor, agent);
    const from = actor.name;
    // In-process session → handed to it directly. Otherwise (desk session, or none yet) → queued; the desk polls control.
    // Either way it waits for the next turn boundary unless `now`, which aborts the current turn first.
    const result = app.runtime ? await app.runtime.interrupt(agent.id, text, from, now) : false;
    if (result === false) {
      const it = world.ops.enqueueInterrupt(agent.id, text, from, now);
      return { ok: true, queued: true, interruptId: it.id };
    }
    return { ok: true, result: result ?? null };
  });

  /**
   * Talk to an agent (any signed-in user). The text becomes a `tell` from the user's avatar. A working agent is
   * interrupted (`now`, default true) or finds it in its inbox; an idle/stopped one gets a `Message from …` assignment.
   * → { mode: 'interrupted' | 'queued' | 'started', messageId, assignmentId? }
   */
  app.post<{ Params: Params }>("/api/agents/:id/message", async (req) => {
    const user = requireUser(req);
    const { text, now } = parse(MessageAgentInput, req.body);
    return world.ops.messageAgent(user.id, req.params.id, text, { now });
  });

  /** The `tell`s between this agent and the user's avatar, oldest first (last 200). `?userId=` defaults to the caller (another user's needs admin). → { messages } */
  app.get<{ Params: Params }>("/api/agents/:id/thread", async (req) => {
    const { userId } = parse(z.object({ userId: z.string().optional() }), req.query);
    const me = requireUser(req);
    const uid = userId ?? me.id;
    if (uid !== me.id && !world.permissions.isAdmin(world.ops.ensureAvatar(me.id))) throw new AppError("forbidden", "You can only read your own threads.");
    return { messages: world.ops.thread(req.params.id, uid) };
  });

  app.post<{ Params: Params }>("/api/agents/:id/chat", async (req) => {
    requireAuth(req);
    const input = parse(ChatInput, req.body);
    const agent = world.agents.require(req.params.id, "agent");
    const r = await runtimeOr503(app).chat(agent.id, input);
    return { reply: typeof r === "string" ? r : r.reply };
  });

  app.post<{ Params: Params }>("/api/agents/:id/stop", async (req) => {
    const agent = world.ops.stopAgent(actorOf(world, req), req.params.id);
    // The runtime aborts the agent's live session itself from the agent.status/agent.banned event.
    return { agent };
  });

  /** Un-stop: back to `idle` with no new assignment. A no-op unless the agent is `stopped`. → { agent } */
  app.post<{ Params: Params }>("/api/agents/:id/resume", async (req) => {
    return { agent: world.ops.resumeAgent(actorOf(world, req), req.params.id) };
  });

  /** Reorder the queue: `order` (pending assignment ids) first, the rest after in their current order. → { assignments (the queue, in order), agent } */
  app.post<{ Params: Params }>("/api/agents/:id/queue", async (req) => {
    const { order } = parse(z.object({ order: z.array(z.string()) }), req.body);
    const assignments = world.ops.reorderQueue(actorOf(world, req), req.params.id, order);
    return { assignments, agent: world.agents.require(req.params.id, "agent") };
  });

  /** Run this pending assignment next. A stopped agent is resumed. → { assignment, agent, when: 'now' | 'after-current' } */
  app.post<{ Params: Params }>("/api/assignments/:id/start-next", async (req) => world.ops.startNext(actorOf(world, req), req.params.id));

  /** Cancel a pending assignment (409 for active/done/cancelled). → { assignment, agent } */
  app.post<{ Params: Params }>("/api/assignments/:id/cancel", async (req) => {
    const assignment = world.ops.cancelAssignment(actorOf(world, req), req.params.id);
    return { assignment, agent: world.agents.require(assignment.agentId, "agent") };
  });

  /** Retry a cancelled or done assignment as a new pending one (`fromAssignmentId`), at the front unless `front: false`. → 201 { assignment, agent } */
  app.post<{ Params: Params }>("/api/assignments/:id/retry", async (req, reply) => {
    const { front } = parse(z.object({ front: z.boolean().default(true) }), req.body ?? {});
    const assignment = world.ops.retryAssignment(actorOf(world, req), req.params.id, { front });
    return reply.code(201).send({ assignment, agent: world.agents.require(assignment.agentId, "agent") });
  });

  /**
   * Dismiss: building.manage on the agent's home building (or admin). `?purge=1` also deletes the desk's home volume.
   * → { agent, cancelledAssignments, revokedTokens, removedMemberships, deskFreed, purge }
   */
  app.delete<{ Params: Params }>("/api/agents/:id", async (req) => {
    const { purge } = parse(z.object({ purge: z.enum(["1", "0", "true", "false"]).optional() }), req.query);
    const p = purge === "1" || purge === "true";
    const r = world.ops.dismissAgent(actorOf(world, req), req.params.id, { purge: p });
    if (app.runtime?.onAgentRetired) {
      try { await app.runtime.onAgentRetired(req.params.id, { purge: p }); } catch (e) { app.log.error({ err: e }, "[server] runtime.onAgentRetired failed"); }
    }
    return { ...r, purge: p };
  });

  /** Ban (town.ban: town moderators, admin). */
  app.post<{ Params: Params }>("/api/agents/:id/ban", async (req) => {
    const { reason } = parse(z.object({ reason: z.string().default("Banned by a human") }), req.body);
    await world.verbs.ban(actorOf(world, req), { agentId: req.params.id, reason });
    return { agent: world.agents.require(req.params.id, "agent") };
  });
}
