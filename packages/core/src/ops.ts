import { WorkInput, type Agent, type Assignment, type Interrupt, type CreateBuildingInput, type CreateMeetingInput, type CreateResidentInput, type Doc, type Meeting, type Membership, type RegisterVisitorInput, type Session } from "@agent-town/schema";
import { createAssignment, createDoc, homeOf, intrayOf, sendMessage, setAssignmentStatus, updateDoc } from "./domain.ts";
import { CHECK_IN } from "./prompts.ts";
import { createBuilding, createResident, createUser, ensureAvatar, registerVisitor, updateBuilding } from "./entities.ts";
import { AppError, badRequest, forbidden } from "./errors.ts";
import { createMeeting, endMeeting, meetingDecide, meetingSpeak, setMeetingPhase } from "./meetings.ts";
import { newId, nowIso } from "./util.ts";
import type { World } from "./world.ts";

export type RequestAction = "approve" | "reject" | "claim" | "done";
/** `null` actor = system (scheduler/runtime): no permission checks. */
export type Actor = Agent | null;

/**
 * Non-verb operations the server (REST) and runtime need. Humans act through their avatar
 * agent (`ensureAvatar(userId)`), so permissions resolve to the user's roles.
 */
export class Ops {
  constructor(private world: World) {}

  // ---- people & buildings ----
  createUser(name: string, opts: { id?: string } = {}) { return createUser(this.world, name, opts); }
  ensureAvatar(userId: string): Agent { return ensureAvatar(this.world, userId); }
  registerVisitor(userId: string, input: (typeof RegisterVisitorInput)["_input"]) { return registerVisitor(this.world, userId, input); }

  createBuilding(actor: Actor, input: (typeof CreateBuildingInput)["_input"]) {
    if (actor) this.world.permissions.require(actor, "town.manage_buildings");
    const creator = actor ? this.world.holderOf(actor) : null;
    return createBuilding(this.world, input, creator?.kind === "user" ? creator.id : null);
  }
  updateBuilding(actor: Actor, id: string, patch: Partial<(typeof CreateBuildingInput)["_input"]>) {
    if (actor) this.world.permissions.require(actor, "building.manage", id);
    return updateBuilding(this.world, id, patch);
  }
  createResident(actor: Actor, input: (typeof CreateResidentInput)["_input"]) {
    if (actor) this.world.permissions.require(actor, "building.manage", input.buildingId);
    return createResident(this.world, input);
  }

  // ---- roles ----
  assignRole(actor: Actor, m: Membership): void {
    this.requireRoleAdmin(actor, m.roleId);
    if (m.holderKind === "agent") this.world.agents.require(m.holderId, "agent"); else this.world.users.require(m.holderId, "user");
    this.world.memberships.add(m);
    this.world.events.append({ type: "system", agentId: m.holderKind === "agent" ? m.holderId : null, text: `${this.world.nameOf(m.holderId)} now holds ${m.roleId}`, payload: { ...m, granted: true } });
  }
  unassignRole(actor: Actor, m: Membership): void {
    this.requireRoleAdmin(actor, m.roleId);
    this.world.memberships.remove(m);
    this.world.events.append({ type: "system", agentId: m.holderKind === "agent" ? m.holderId : null, text: `${this.world.nameOf(m.holderId)} no longer holds ${m.roleId}`, payload: { ...m, granted: false } });
  }
  private requireRoleAdmin(actor: Actor, roleId: string): void {
    const role = this.world.roles.require(roleId, "role");
    if (!actor) return;
    const ok = this.world.permissions.can(actor, "town.manage_roles") || (role.scope === "building" && this.world.permissions.can(actor, "building.manage", role.buildingId));
    if (!ok) throw forbidden(role.scope === "town" ? "town.manage_roles" : "building.manage");
  }

  // ---- dismiss ----
  /**
   * DELETE /api/agents/:id. Needs building.manage (or building.dismiss) on the agent's home building, or admin.
   * Frees the desk, revokes the agent's tokens, removes its memberships, cancels pending/active assignments, sets
   * status `retired` (row kept so documents keep their author), appends `agent.retired`. The session/container part
   * is the runtime's (`onAgentRetired`); call it after this.
   */
  dismissAgent(actor: Actor, agentId: string, opts: { purge?: boolean } = {}): { agent: Agent; cancelledAssignments: string[]; revokedTokens: number; removedMemberships: number; deskFreed: boolean } {
    const agent = this.world.agents.require(agentId, "agent");
    const bid = homeOf(agent);
    if (actor) {
      const p = this.world.permissions;
      if (!p.isAdmin(actor) && !p.can(actor, "building.manage", bid) && !p.can(actor, "building.dismiss", bid)) throw forbidden("building.manage");
    }
    if (agent.kind === "human") throw badRequest("Humans can't be dismissed.");
    if (agent.status === "retired") throw new AppError("conflict", `${agent.name} was already dismissed.`);
    return this.world.transaction(() => {
      this.world.movement.cancel(agentId, "Dismissed.");
      const cancelled: string[] = [];
      for (const a of this.world.assignments.where("agentId = ? AND status IN ('pending','active')", [agentId])) {
        setAssignmentStatus(this.world, a.id, "cancelled");
        cancelled.push(a.id);
      }
      const revokedTokens = this.world.tokens.revokeAll("agent", agentId);
      const removedMemberships = this.world.memberships.removeAll("agent", agentId);
      const deskFreed = !!this.world.layout.deskOf(agentId);
      if (deskFreed) this.world.layout.releaseDesk(agentId);
      this.world.agents.patch(agentId, { currentAssignmentId: null, currentMeetingId: null, activity: "" });
      const retired = this.world.setStatus(agentId, "retired", `${agent.name} was dismissed`);
      const by = actor ? this.world.holderOf(actor).id : "system";
      this.world.events.append({ type: "agent.retired", agentId, buildingId: bid, text: `${agent.name} was dismissed${actor ? ` by ${actor.name}` : ""}`, payload: { by, purge: !!opts.purge, cancelledAssignments: cancelled, deskFreed } });
      return { agent: retired, cancelledAssignments: cancelled, revokedTokens, removedMemberships, deskFreed };
    });
  }

  // ---- in-tray ----
  /** The building's pending reports, oldest first (GET /api/buildings/:id/intray). */
  intray(buildingId: string): Doc[] {
    this.world.buildings.require(buildingId, "building");
    return intrayOf(this.world, buildingId);
  }

  // ---- reconcile (runtime startup) ----
  /**
   * After a restart: running Session rows whose agent has no live child (not in `liveAgentIds`) end with
   * `error: 'orphaned at restart'`; `active` assignments whose agent then has no running session go back to `pending`.
   */
  reconcile(liveAgentIds: Iterable<string> = []): { orphanedSessions: string[]; requeuedAssignments: string[] } {
    const live = new Set(liveAgentIds);
    const orphanedSessions: string[] = [];
    const requeuedAssignments: string[] = [];
    this.world.transaction(() => {
      for (const s of this.world.sessions.where("status = 'running'")) {
        if (live.has(s.agentId)) continue;
        this.endSession(s.id, { status: "error", error: "orphaned at restart" });
        orphanedSessions.push(s.id);
      }
      for (const a of this.world.assignments.where("status = 'active'")) {
        if (this.world.sessions.count("agentId = ? AND status = 'running'", [a.agentId])) continue;
        setAssignmentStatus(this.world, a.id, "pending");
        requeuedAssignments.push(a.id);
        const agent = this.world.agents.get(a.agentId);
        if (agent?.currentAssignmentId === a.id) this.world.agents.patch(a.agentId, { currentAssignmentId: null });
      }
      // bodies left "working" with no running session
      for (const ag of this.world.agents.where("status = 'working'")) {
        if (!this.world.sessions.count("agentId = ? AND status = 'running'", [ag.id])) this.world.setStatus(ag.id, "idle");
      }
    });
    if (orphanedSessions.length || requeuedAssignments.length) {
      this.world.events.append({ type: "system", text: `Reconciled at startup: ${orphanedSessions.length} orphaned session(s), ${requeuedAssignments.length} assignment(s) back to pending`, payload: { orphanedSessions, requeuedAssignments } });
    }
    return { orphanedSessions, requeuedAssignments };
  }

  // ---- work, sessions, agent control ----
  /** POST /agents/:id/work: create a pending assignment (building.assign or owner). Clears `stopped`. */
  createWork(actor: Actor, agentId: string, input: (typeof WorkInput)["_input"] = {}): Assignment {
    const inp = WorkInput.parse(input);
    const agent = this.world.agents.require(agentId, "agent");
    if (actor) this.requireAgentControl(actor, agent);
    if (agent.status === "banned" || agent.status === "retired") throw new AppError("conflict", `${agent.name} is ${agent.status === "retired" ? "dismissed" : "banned"}.`);
    const a = createAssignment(this.world, {
      agentId, title: inp.title ?? "Check in", description: inp.description ?? CHECK_IN,
      createdBy: actor ? this.world.holderOf(actor) : { kind: "system", id: "system" },
    });
    if (agent.status === "stopped") this.world.setStatus(agentId, "idle");
    return a;
  }
  stopAgent(actor: Actor, agentId: string): Agent {
    const agent = this.world.agents.require(agentId, "agent");
    if (actor) this.requireAgentControl(actor, agent);
    this.world.movement.cancel(agentId, "Stopped.");
    return this.world.setStatus(agentId, "stopped", `${agent.name} was stopped`);
  }
  requireAgentControl(actor: Agent, agent: Agent): void {
    const h = this.world.holderOf(actor);
    const owner = h.kind === "user" && agent.ownerUserId === h.id;
    if (!owner && !this.world.permissions.can(actor, "building.assign", homeOf(agent))) throw forbidden("building.assign");
  }

  /** Runtime: a session starts. Work sessions activate the assignment and set status `working`. */
  startSession(agentId: string, opts: { purpose: Session["purpose"]; model: string; assignmentId?: string | null; meetingId?: string | null; backend?: Session["backend"] }): Session {
    const agent = this.world.agents.require(agentId, "agent");
    const session = this.world.sessions.upsert({
      id: newId("se"), agentId, assignmentId: opts.assignmentId ?? null, meetingId: opts.meetingId ?? null, purpose: opts.purpose, backend: opts.backend ?? "host",
      status: "running", model: opts.model, sdkSessionId: null, tokens: 0, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: null,
    });
    if (opts.purpose === "work") {
      if (opts.assignmentId) {
        const a = this.world.assignments.require(opts.assignmentId, "assignment");
        if (a.status === "pending") setAssignmentStatus(this.world, a.id, "active");
        this.world.agents.patch(agentId, { currentAssignmentId: a.id });
      }
      this.world.setStatus(agentId, "working");
    }
    this.world.events.append({ type: "session.started", agentId, buildingId: homeOf(agent), text: `${agent.name} started a ${opts.purpose} session`, payload: { sessionId: session.id, purpose: opts.purpose, assignmentId: opts.assignmentId ?? null, model: opts.model, backend: session.backend } });
    return session;
  }

  /** Runtime: a session ended. A work session still `working` (no report) leaves the agent idle. Does not charge; call budget.charge. */
  endSession(sessionId: string, result: { status: Exclude<Session["status"], "running">; tokens?: number; costUsd?: number; turns?: number; error?: string | null; sdkSessionId?: string | null }): Session {
    const s = this.world.sessions.require(sessionId, "session");
    const session = this.world.sessions.upsert({
      ...s, status: result.status, tokens: result.tokens ?? s.tokens, costUsd: result.costUsd ?? s.costUsd, turns: result.turns ?? s.turns,
      error: result.error ?? null, sdkSessionId: result.sdkSessionId ?? s.sdkSessionId, endedAt: nowIso(),
    });
    const agent = this.world.agents.require(s.agentId, "agent");
    if (agent.status === "working") this.world.setStatus(agent.id, "idle");
    this.world.events.append({ type: "session.ended", agentId: agent.id, buildingId: homeOf(agent), text: `${agent.name}'s ${s.purpose} session ended (${result.status})`, payload: { sessionId, status: result.status, tokens: session.tokens, costUsd: session.costUsd, turns: session.turns, reportId: session.reportId, error: session.error } });
    return session;
  }

  /** Latest session for an agent (running first). */
  currentSession(agentId: string): Session | undefined {
    return this.world.sessions.first("agentId = ?", [agentId], "ORDER BY (status = 'running') DESC, startedAt DESC, rowid DESC");
  }

  // ---- interrupts (queued for sessions that run outside the server process, i.e. desks) ----
  /** Queue `text` for the agent's running session (or its next one if none is running). */
  enqueueInterrupt(agentId: string, text: string, from: string): Interrupt {
    const agent = this.world.agents.require(agentId, "agent");
    const running = this.world.sessions.first("agentId = ? AND status = 'running' AND purpose = 'work'", [agentId], "ORDER BY startedAt DESC, rowid DESC");
    const it = this.world.interrupts.upsert({ id: newId("in"), agentId, sessionId: running?.id ?? null, text, from, createdAt: nowIso(), deliveredAt: null });
    this.world.events.append({ type: "system", agentId, buildingId: homeOf(agent), text: `Interrupt for ${agent.name}: ${text.slice(0, 200)}`, payload: { sessionId: it.sessionId, interrupt: true, queued: true, interruptId: it.id, text } });
    return it;
  }
  /** Undelivered interrupts for the agent, oldest first: those for `sessionId` plus unbound ones (sessionId null). */
  pendingInterrupts(agentId: string, sessionId?: string): Interrupt[] {
    return sessionId
      ? this.world.interrupts.where("agentId = ? AND deliveredAt IS NULL AND (sessionId IS NULL OR sessionId = ?)", [agentId, sessionId], "ORDER BY createdAt, rowid")
      : this.world.interrupts.where("agentId = ? AND deliveredAt IS NULL", [agentId], "ORDER BY createdAt, rowid");
  }
  /** Mark interrupts delivered. Returns how many were newly acked. */
  ackInterrupts(ids: string[], agentId?: string): number {
    let n = 0;
    const at = nowIso();
    for (const id of ids) {
      const it = this.world.interrupts.get(id);
      if (!it || it.deliveredAt || (agentId && it.agentId !== agentId)) continue;
      this.world.interrupts.upsert({ ...it, deliveredAt: at });
      n++;
    }
    return n;
  }

  // ---- outbox requests ----
  /**
   * approve/reject: town.approve_request or building.review in the doc's building.
   * claim: any human (avatar). done: the claimer (or admin) with `body` → creates a `human-report` in the library.
   */
  requestAction(actor: Agent, docId: string, action: RequestAction, body?: string): { request: Doc; humanReport: Doc | null } {
    const doc = this.world.docs.require(docId, "doc");
    if (doc.type !== "request") throw badRequest(`Doc ${docId} is not a request.`);
    const h = this.world.holderOf(actor);
    const need = (from: Doc["requestStatus"][]) => {
      if (!from.includes(doc.requestStatus)) throw new AppError("conflict", `Request is ${doc.requestStatus}; can't ${action}.`);
    };
    let humanReport: Doc | null = null;
    let patch: Partial<Doc>;
    switch (action) {
      case "approve":
      case "reject":
        if (!this.world.permissions.can(actor, "town.approve_request") && !this.world.permissions.can(actor, "building.review", doc.buildingId)) throw forbidden("town.approve_request");
        need(["proposed"]);
        patch = { requestStatus: action === "approve" ? "approved" : "rejected" };
        break;
      case "claim":
        if (h.kind !== "user") throw badRequest("Only humans can claim requests.");
        need(["approved"]);
        patch = { requestStatus: "claimed", claimedByUserId: h.id };
        break;
      case "done":
        if (h.kind !== "user") throw badRequest("Only humans can complete requests.");
        need(["claimed"]);
        if (doc.claimedByUserId !== h.id && !this.world.permissions.isAdmin(actor)) throw new AppError("forbidden", "Only the human who claimed this request can complete it.");
        if (!body?.trim()) throw badRequest("Completing a request needs a report body.");
        humanReport = createDoc(this.world, {
          type: "human-report", state: "library", title: `Re: ${doc.title}`, body, authorId: h.id, authorKind: "user",
          buildingId: doc.buildingId, tags: [`request:${doc.id}`], location: doc.location,
        }, `${this.world.nameOf(h.id)} reported back on "${doc.title}"`);
        patch = { requestStatus: "done" };
        if (doc.authorKind === "agent") sendMessage(this.world, { kind: "system", fromId: h.id, fromKind: "system", toId: doc.authorId, body: `A human answered your request "${doc.title}": see ${humanReport.id}.` });
        break;
    }
    const request = updateDoc(this.world, doc.id, patch);
    this.world.events.append({ type: "doc.updated", buildingId: doc.buildingId, agentId: doc.authorKind === "agent" ? doc.authorId : null, text: `Request "${doc.title}" is ${request.requestStatus}`, payload: { docId: doc.id, requestStatus: request.requestStatus, by: h.id } });
    return { request, humanReport };
  }

  /** Outbox: approved/claimed requests (what humans see). */
  outbox(includeAll = false): Doc[] {
    return includeAll
      ? this.world.docs.where("type = 'request'", [], "ORDER BY createdAt DESC")
      : this.world.docs.where("type = 'request' AND requestStatus IN ('approved','claimed')", [], "ORDER BY createdAt DESC");
  }

  // ---- trophies ----
  decideTrophy(actor: Actor, docId: string, approve: boolean): Doc {
    if (actor) this.world.permissions.require(actor, "town.approve_trophy");
    const d = this.world.docs.require(docId, "doc");
    if (!d.trophyProposedBy && approve && d.state !== "library") throw badRequest("Doc wasn't proposed and isn't in the library.");
    const doc = approve
      ? updateDoc(this.world, d.id, { state: "trophy" })
      : updateDoc(this.world, d.id, { trophyProposedBy: undefined, trophyWhy: undefined });
    this.world.events.append({ type: approve ? "doc.state" : "doc.updated", buildingId: d.buildingId, text: approve ? `"${d.title}" entered the trophy room` : `Trophy proposal for "${d.title}" declined`, payload: { docId, state: doc.state, trophy: approve } });
    return doc;
  }

  // ---- meetings ----
  createMeeting(actor: Actor, input: (typeof CreateMeetingInput)["_input"]): Meeting { return createMeeting(this.world, input, actor ?? undefined); }
  setMeetingPhase(meetingId: string, phase: Meeting["phase"]): Meeting { return setMeetingPhase(this.world, meetingId, phase); }
  /** POST /meetings/:id/start → discussing. */
  startMeeting(actor: Actor, meetingId: string): Meeting {
    const m = this.world.meetings.require(meetingId, "meeting");
    if (actor && m.facilitatorId !== actor.id && !this.world.permissions.can(actor, "meeting.facilitate", m.buildingId ?? "town-hall") && !this.world.permissions.can(actor, "building.review", m.buildingId ?? "town-hall")) throw forbidden("meeting.facilitate");
    return setMeetingPhase(this.world, meetingId, "discussing");
  }
  meetingSay(actor: Agent, meetingId: string, text: string): Meeting { return meetingSpeak(this.world, actor, meetingId, text); }
  meetingDecide(actor: Actor, meetingId: string, decisions: Meeting["decisions"]): Meeting { return meetingDecide(this.world, actor, meetingId, decisions); }
  endMeeting(actor: Actor, meetingId: string, closing?: string): Meeting {
    if (actor) {
      const m = this.world.meetings.require(meetingId, "meeting");
      if (m.facilitatorId !== actor.id && !this.world.permissions.can(actor, "meeting.facilitate", m.buildingId ?? "town-hall") && !this.world.permissions.can(actor, "building.review", m.buildingId ?? "town-hall")) throw forbidden("meeting.facilitate");
    }
    return endMeeting(this.world, null, meetingId, closing);
  }
}
