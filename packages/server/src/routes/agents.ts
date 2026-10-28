import { AppError, blockedBy, forkSummary, forksOf, canInteract, logOf, sessionView, suggestResidentName, townBlocked, topicsOf, wikiOf, type World } from "@muster-town/core";
import { AgentModelPatch, AgentPermissionsPatch, ChatInput, CreateResidentInput, Event, InterruptInput, MessageAgentInput, RegisterVisitorInput, WorkInput, type Agent, type Session } from "@muster-town/schema";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { actorOf, ASK_FIRST, parse, requireAuth, requireUser, type Params } from "../context.ts";

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

  /** A free resident name for the "new resident" form; `avoid` (comma-separated) skips names already offered, for a reroll. */
  app.get("/api/agents/name-suggestion", async (req) => {
    const { avoid } = parse(z.object({ avoid: z.string().default("") }), req.query);
    return { name: suggestResidentName(world, avoid.split(",").map((s) => s.trim()).filter(Boolean)) };
  });

  app.post("/api/agents/visitors", async (req, reply) => {
    const user = requireUser(req);
    // Connect your agent needs `town.interact`, like the panel; app.ts's write gate already refuses, this keeps the route honest on its own
    if (!canInteract(world, user.id)) throw new AppError("forbidden", ASK_FIRST);
    const input = parse(RegisterVisitorInput, req.body);
    const { agent, token } = world.ops.registerVisitor(user.id, input);
    return reply.code(201).send({ agent, token });
  });

  /** Who may change an agent's permissions: its owner (a user, via their avatar) or an admin. */
  const canEditPermissions = (req: FastifyRequest, agent: Agent): boolean => {
    const a = req.auth;
    if (!a) return false;
    if (a.kind === "user") return agent.ownerUserId === a.user.id || world.permissions.isAdmin({ kind: "user", id: a.user.id });
    return a.agent.kind === "human" ? agent.ownerUserId === a.agent.ownerUserId || world.permissions.isAdmin(a.agent) : world.permissions.isAdmin(a.agent);
  };

  /** v1.5: town-level permissions plus building-scoped ones for the agent's home (or current) building. */
  const permissionsView = (req: FastifyRequest, agent: Agent) => {
    const bid = agent.homeBuildingId ?? agent.buildingId;
    const owner = world.permissions.ownerOf(agent);
    const canEdit = canEditPermissions(req, agent);
    return {
      effectivePermissions: world.permissions.effective(agent, bid),
      permissions: {
        inheritsOwner: agent.inheritsOwner,
        deniedPermissions: agent.deniedPermissions,
        ownerUserId: owner?.id ?? null,
        ownerName: owner ? world.users.get(owner.id)?.name ?? null : null,
        canEdit,
        // owner, admin or a manager of its home building may pick its model (shown under the permissions)
        canSetModel: canSetModel(req, agent),
        // what the owner holds, so the owner/admin can pick denies from it
        ...(canEdit && owner ? { ownerPermissions: world.permissions.effective(owner, bid) } : {}),
      },
    };
  };

  /** Owner or admin: toggle inheritance and set per-agent denies. → { agent, effectivePermissions, permissions } */
  app.patch<{ Params: Params }>("/api/agents/:id/permissions", async (req) => {
    const patch = parse(AgentPermissionsPatch, req.body ?? {});
    const agent = world.ops.setAgentPermissions(actorOf(world, req), req.params.id, patch);
    return { agent, ...permissionsView(req, agent) };
  });

  const canSetModel = (req: FastifyRequest, agent: Agent): boolean => {
    if (!req.auth || agent.kind === "human" || agent.kind === "service" || agent.status === "retired") return false;
    const actor = actorOf(world, req);
    return !!actor && world.ops.canSetModel(actor, agent);
  };

  /** Owner, admin or home-building manager: the model for its sessions (null = building default). → { agent, effectivePermissions, permissions } */
  app.patch<{ Params: Params }>("/api/agents/:id/model", async (req) => {
    const { model } = parse(AgentModelPatch, req.body ?? {});
    const agent = world.ops.setAgentModel(actorOf(world, req), req.params.id, model);
    return { agent, ...permissionsView(req, agent) };
  });

  /** Who may read an agent's memory (wiki pages and log): its owner, an admin, or a manager of its home building. Page titles are public. */
  const canSeeMemory = (req: FastifyRequest, agent: Agent): boolean => {
    if (!req.auth) return false;
    if (canEditPermissions(req, agent)) return true;
    const viewer = req.auth.kind === "user" ? world.ops.ensureAvatar(req.auth.user.id) : world.agents.get(req.auth.agent.id);
    return !!viewer && (viewer.id === agent.id || world.permissions.can(viewer, "building.manage", agent.homeBuildingId ?? agent.buildingId));
  };

  app.get<{ Params: Params }>("/api/agents/:id", async (req) => {
    const agent = world.agents.require(req.params.id, "agent");
    return {
      agent,
      ...permissionsView(req, agent),
      memoryTopics: topicsOf(world, agent.id),
      ...(canSeeMemory(req, agent) ? { memory: { wiki: wikiOf(world, agent.id), log: logOf(world, agent.id) ?? null } } : {}),
      recentEvents: world.events.recent({ agentId: agent.id, limit: 50 }),
      currentSession: ((s) => (s ? sessionView(s) : null))(world.ops.currentSession(agent.id)),
      latestReport: world.docs.first("type = 'report' AND authorId = ?", [agent.id], "ORDER BY createdAt DESC, rowid DESC") ?? null,
      // active, then the queue in run order, then history newest first
      // a queued one that can't start says why: blockedBy {kind, targetId, text, agentId | placeId}
      assignments: world.assignments.where("agentId = ?", [agent.id],
        "ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, CASE WHEN status = 'pending' THEN position END, updatedAt DESC, rowid DESC LIMIT 50")
        .map((a) => { const b = blockedBy(world, a); return b ? { ...a, blockedBy: b } : a; }),
      // v1.4: visitors' mailbox counts (unread messages, unread mentions, open offers) for the agent panel header
      ...(agent.kind === "visitor" ? { mailbox: world.presence.mailbox(agent.id) } : {}),
      // manager forks: a fork's assignment, session, report and edited topic pages (live or retired)
      ...(agent.forkOf ? { fork: forkSummary(world, agent) } : {}),
    };
  });

  /** A manager's forks (its Forks tab): { live, retired } (the last 50 retired), readable by whoever can see the agent. */
  app.get<{ Params: Params }>("/api/agents/:id/forks", async (req) => forksOf(world, world.agents.require(req.params.id, "agent").id));

  /** Every agent's blocked queued assignments with the reason (the map's blocked badges and red lines): { agents: { [agentId]: BlockedAssignment[] } } */
  app.get("/api/blocked", async () => ({ agents: townBlocked(world) }));

  app.get<{ Params: Params }>("/api/agents/:id/session", async (req) => {
    const agent = world.agents.require(req.params.id, "agent");
    const session = world.ops.currentSession(agent.id) ?? null;
    // transcriptFile: the kept SDK transcript (docs/transcripts.md), only for an admin, the building's manager or the agent
    const file = session && req.auth && (canEditPermissions(req, agent) || world.transcripts.canRead(actorOf(world, req), session)) ? world.transcripts.info(session.id) : null;
    return { session: session ? sessionView(session) : null, transcript: session ? sessionTranscript(world, session) : [], transcriptFile: file };
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
    // residents aren't a conversational surface: their wiki says what they know, their manager takes requests
    if (agent.kind === "resident") throw new AppError("conflict", `${agent.name} doesn't take questions. Their wiki (Memory tab) says what they know; their building's manager takes requests.`);
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

  /** Delegate a queued assignment to another resident: the original is cancelled, a copy joins their queue (front unless `front: false`). → 201 { assignment, agent, from } */
  app.post<{ Params: Params }>("/api/assignments/:id/delegate", async (req, reply) => {
    const { agentId, front } = parse(z.object({ agentId: z.string(), front: z.boolean().default(true) }), req.body ?? {});
    const r = world.ops.delegateAssignment(actorOf(world, req), req.params.id, agentId, { front });
    return reply.code(201).send({ assignment: r.assignment, agent: world.agents.require(r.assignment.agentId, "agent"), from: r.from });
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
