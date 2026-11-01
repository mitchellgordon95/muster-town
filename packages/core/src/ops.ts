import { AgentPermissionsPatch, WorkInput, NEW_LAB_LOT, desksForLot, SPEND_LIMIT, countsOf, splitRaw, type TokenCounts, type Agent, type Assignment, type Interrupt, type CreateBuildingInput, type UpdateBuildingInput, type CreateMeetingInput, type CreateResidentInput, type Doc, type Meeting, type Membership, type RegisterVisitorInput, type Session } from "@muster-town/schema";
import { createAssignment, createDoc, homeOf, intrayCount, intrayOf, moveToFront, pendingQueue, plantFlag, sendMessage, setAssignmentStatus, townHallIntray, updateDoc } from "./domain.ts";
import { CHECK_IN } from "./prompts.ts";
import { createBuilding, createResident, createUser, ensureAvatar, registerVisitor, updateBuilding, updateFurniture } from "./entities.ts";
import type { Furniture } from "./world/furniture.ts";
import { AppError, badRequest, forbidden } from "./errors.ts";
import { agentsDrafting, clearAgentDrafting, createMeeting, createOneOnOne, endMeeting, meetingDecide, meetingSpeak, noteHumanTyping, presentSlide, recordSlideDecision, setMeetingPhase } from "./meetings.ts";
import { archiveReport, type ArchiveResult } from "./archive.ts";
import { newId, nowIso } from "./util.ts";
import { humanOrigin, meetingOrigin } from "./origin.ts";
import { BANK_MODEL, sessionView, unknownModels } from "./bank.ts";
import { validateWait } from "./waits.ts";
import { walkHome } from "./home.ts";
import { requestAnswerWake } from "./wakes.ts";
import type { World } from "./world.ts";

export interface ThreadMessage { id: string; fromId: string; toId: string; from: string; mine: boolean; body: string; at: string }

/** Models already warned about this process (Bank step 2: an unknown model is priced as Opus 5.5). */
const warnedModels = new Set<string>();


interface StartNextResult { assignment: Assignment; agent: Agent; when: "now" | "after-current" }

export type RequestAction = "claim" | "done" | "delete";
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
    // attached to the root unless a goal is picked; picking one takes goals.edit there (docs/goals.md)
    if (actor && input.goalId) this.world.goalTree.requireEdit(actor, input.goalId);
    const creator = actor ? this.world.holderOf(actor) : null;
    // its size follows its desks (docs/goals.md "The map is the tree"): NEW_LAB_LOT's desks unless it says how many
    return createBuilding(this.world, { ...input, headcount: input.headcount ?? desksForLot(NEW_LAB_LOT) }, creator?.kind === "user" ? creator.id : null, { starterResidents: true });
  }
  /**
   * The rest needs building.manage. `headcount` (Desks) sets the building's size on the map, which is drawn from the goal
   * tree, and its daily cap (daily budget / agent × desks): `town.manage_buildings`, the permission that covered resizing on
   * the map table. The exploration cap is the attached goal's (PATCH /api/goals/:id).
   */
  updateBuilding(actor: Actor, id: string, patch: (typeof UpdateBuildingInput)["_input"]) {
    const { goalId, ...rest } = patch;
    if (actor && rest.headcount !== undefined) this.world.permissions.require(actor, "town.manage_buildings");
    const other = Object.keys(rest).length || goalId === undefined;
    if (actor && other) this.world.permissions.require(actor, "building.manage", id);
    // the goal it is attached to: goals.edit (admins, or the owner) on both the old and the new goal, never unset
    if (goalId !== undefined) this.world.goalTree.attach(actor, id, goalId);
    const updated = other ? updateBuilding(this.world, id, rest) : this.world.buildings.require(id, "building");
    this.world.budget.resumeEligible(id); // residents held out-of-budget whose building can start again go idle
    return updated;
  }
  /** Furniture is edited by humans only (Mitchell, 2026-10-20): an agent token is refused even with building.manage. */
  layoutPreview(actor: Actor, id: string, furniture: Furniture) {
    this.requireLayoutEditor(actor, id);
    return this.world.layout.preview(id, furniture);
  }
  updateFurniture(actor: Actor, id: string, furniture: Furniture) {
    this.requireLayoutEditor(actor, id);
    return updateFurniture(this.world, id, furniture, actor ? this.world.holderOf(actor).id : null);
  }
  private requireLayoutEditor(actor: Actor, id: string) {
    if (!actor) return;
    if (actor.kind !== "human") throw new AppError("forbidden", "Only humans can rearrange furniture.");
    this.world.permissions.require(actor, "building.manage", id);
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

  /** PATCH /api/agents/:id/permissions: the agent's owner (via their avatar) or an admin toggles inheritance / sets denies. */
  setAgentPermissions(actor: Actor, agentId: string, patch: (typeof AgentPermissionsPatch)["_input"]): Agent {
    const agent = this.world.agents.require(agentId, "agent");
    const p = AgentPermissionsPatch.parse(patch);
    if (actor) {
      const h = this.world.holderOf(actor);
      const owner = h.kind === "user" && !!agent.ownerUserId && agent.ownerUserId === h.id && actor.kind === "human";
      if (!owner && !this.world.permissions.isAdmin(actor)) throw new AppError("forbidden", "Only the agent's owner or an admin can change its permissions.");
    }
    const next: Partial<Agent> = {};
    if (p.inheritsOwner !== undefined) next.inheritsOwner = p.inheritsOwner;
    if (p.deniedPermissions !== undefined) next.deniedPermissions = [...new Set(p.deniedPermissions)];
    const updated = this.world.agents.patch(agentId, next);
    this.world.events.append({ type: "system", agentId, text: `${agent.name}'s permissions changed: ${updated.inheritsOwner ? "inherits its owner" : "own roles only"}${updated.deniedPermissions.length ? `, denied ${updated.deniedPermissions.join(", ")}` : ""}`, payload: { inheritsOwner: updated.inheritsOwner, deniedPermissions: updated.deniedPermissions, by: actor ? this.world.holderOf(actor).id : "system" } });
    return updated;
  }

  /**
   * PATCH /api/agents/:id/model. The agent's owner, an admin, or a manager of its home building (building.manage).
   * null clears it so sessions use the home building's model. Takes effect from its next session.
   */
  setAgentModel(actor: Actor, agentId: string, model: string | null): Agent {
    const agent = this.world.agents.require(agentId, "agent");
    if (actor && !this.canSetModel(actor, agent)) throw forbidden("building.manage");
    if (agent.kind === "human" || agent.kind === "service") throw badRequest(`${agent.name} doesn't run model sessions.`);
    const next = model?.trim() || null;
    const updated = this.world.agents.patch(agentId, { model: next });
    this.world.events.append({ type: "system", agentId, text: `${agent.name}'s model: ${next ?? "building default"}`, payload: { model: next, by: actor ? this.world.holderOf(actor).id : "system" } });
    return updated;
  }

  /** Who may change an agent's model: its owner, an admin, or building.manage on its home building. */
  canSetModel(actor: NonNullable<Actor>, agent: Agent): boolean {
    const h = this.world.holderOf(actor);
    if (h.kind === "user" && !!agent.ownerUserId && agent.ownerUserId === h.id && actor.kind === "human") return true;
    const p = this.world.permissions;
    return p.isAdmin(actor) || p.can(actor, "building.manage", homeOf(agent));
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
  /** The in-tray badge count (the Town Hall's includes grants awaiting a decision). */
  intrayCount(buildingId: string): number {
    this.world.buildings.require(buildingId, "building");
    return intrayCount(this.world, buildingId);
  }
  /** The Town Hall in-tray: managers' rollups and checkpoint reports plus grants awaiting a human's decision. */
  townHallIntray() {
    return townHallIntray(this.world);
  }
  /** POST /api/buildings/:id/flags: a human plants a flag (a short request) in a building; it lands in the manager's in-tray. */
  plantFlag(actor: Agent, buildingId: string, text: string): Doc {
    return plantFlag(this.world, actor, buildingId, text);
  }

  /**
   * POST /api/docs/:id/archive (1:1 mt_cz11aqe81a: a report's actions are Talk to the author and Archive). Needs
   * building.review on the report's building (or admin). Acknowledges the report; no assignment.
   */
  archiveReport(actor: Actor, docId: string, opts: { deckSlide?: number } = {}): ArchiveResult {
    const doc = this.world.docs.require(docId, "doc");
    if (actor && !this.world.permissions.isAdmin(actor) && !this.world.permissions.can(actor, "building.review", doc.buildingId)) throw forbidden("building.review");
    return archiveReport(this.world, actor, docId, opts);
  }

  // ---- reconcile (runtime startup) ----
  /**
   * After a restart: running Session rows whose agent has no live child (not in `liveAgentIds`) end `interrupted` with
   * `error: 'cut by restart'` (the restart cut them, they didn't fail: the `sessions` alert counts only `error`); `active` assignments whose agent then has no running session go back to `pending`.
   */
  reconcile(liveAgentIds: Iterable<string> = []): { orphanedSessions: string[]; requeuedAssignments: string[] } {
    const live = new Set(liveAgentIds);
    const orphanedSessions: string[] = [];
    const requeuedAssignments: string[] = [];
    this.world.transaction(() => {
      for (const s of this.world.sessions.where("status = 'running'")) {
        if (live.has(s.agentId)) continue;
        this.endSession(s.id, { status: "interrupted", error: "cut by restart" });
        orphanedSessions.push(s.id);
      }
      // visitors hold their active assignment across restarts (their loop runs outside the town)
      for (const a of this.world.assignments.where("status = 'active' AND agentId NOT IN (SELECT id FROM agents WHERE kind = 'visitor')")) {
        if (this.world.sessions.count("agentId = ? AND status = 'running'", [a.agentId])) continue;
        setAssignmentStatus(this.world, a.id, "pending");
        requeuedAssignments.push(a.id);
        const agent = this.world.agents.get(a.agentId);
        if (agent?.currentAssignmentId === a.id) this.world.agents.patch(a.agentId, { currentAssignmentId: null });
      }
      // bodies left "working" with no running session
      for (const ag of this.world.agents.where("status = 'working' AND kind != 'visitor'")) {
        if (!this.world.sessions.count("agentId = ? AND status = 'running'", [ag.id])) this.world.setStatus(ag.id, "idle");
      }
      // bodies left "walking": walks live in memory, so a restart mid-walk leaves the status with no walk to finish it
      // (and stayReason keeps a "walking" body where it is for good); the runtime tick then walks idle ones home
      for (const ag of this.world.agents.where("status = 'walking'")) {
        if (this.world.movement.isWalking(ag.id)) continue;
        const working = this.world.sessions.count("agentId = ? AND status = 'running'", [ag.id]) > 0;
        this.world.setStatus(ag.id, working ? "working" : "idle");
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
    const waitFor = inp.waitFor ? validateWait(this.world, inp.waitFor) : null;
    const agent = this.world.agents.require(agentId, "agent");
    if (actor) this.requireAgentControl(actor, agent);
    if (agent.status === "banned" || agent.status === "retired") throw new AppError("conflict", `${agent.name} is ${agent.status === "retired" ? "dismissed" : "banned"}.`);
    const a = createAssignment(this.world, {
      agentId, title: inp.title ?? "Check in", description: inp.description ?? CHECK_IN,
      createdBy: actor ? this.world.holderOf(actor) : { kind: "system", id: "system" }, waitFor,
      lane: { lane: inp.lane, grantId: inp.grantId, gap: inp.gap, sourceId: inp.sourceId },
    });
    if (agent.status === "stopped") this.world.setStatus(agentId, "idle");
    return a;
  }
  stopAgent(actor: Actor, agentId: string): Agent {
    const agent = this.world.agents.require(agentId, "agent");
    if (actor) this.requireAgentControl(actor, agent);
    this.world.movement.cancel(agentId, "Stopped.");
    return this.world.setStatus(agentId, "stopped", `${agent.name} was stopped`, { by: actor ? this.world.holderOf(actor) : { kind: "system", id: "system" } });
  }
  /** POST /agents/:id/resume: `stopped` → `idle` without creating an assignment. Pending assignments (if any) run as usual. */
  resumeAgent(actor: Actor, agentId: string): Agent {
    const agent = this.world.agents.require(agentId, "agent");
    // the Planner: whoever plans with it (an admin, a goal's captain) may resume it; the Town Hall has no roles
    if (actor && !(this.world.reorgs.isPlanner(agent) && this.world.reorgs.canPlan(actor))) this.requireAgentControl(actor, agent);
    if (agent.status !== "stopped") return agent;
    return this.world.setStatus(agentId, "idle", `${agent.name} was resumed`, { by: actor ? this.world.holderOf(actor) : { kind: "system", id: "system" } });
  }
  // ---- the assignment queue ----
  // Pending assignments run in `position` order (then createdAt, rowid). Owner, building.assign or admin.
  private controlAssignment(actor: Actor, assignmentId: string): { a: Assignment; agent: Agent } {
    const a = this.world.assignments.require(assignmentId, "assignment");
    const agent = this.world.agents.require(a.agentId, "agent");
    if (actor) this.requireAgentControl(actor, agent);
    return { a, agent };
  }
  /** Put a pending assignment at the front of its agent's queue (no permission check; see `startNext`). */
  moveToFront(assignmentId: string): Assignment { return moveToFront(this.world, assignmentId); }
  /**
   * POST /agents/:id/queue: `orderedIds` (pending assignments of this agent) go first, in that order; pending ones not
   * listed keep their relative order after them.
   */
  reorderQueue(actor: Actor, agentId: string, orderedIds: string[]): Assignment[] {
    const agent = this.world.agents.require(agentId, "agent");
    if (actor) this.requireAgentControl(actor, agent);
    const queue = pendingQueue(this.world, agentId);
    const byId = new Map(queue.map((a) => [a.id, a]));
    const seen = new Set<string>();
    for (const id of orderedIds) {
      if (!byId.has(id)) throw badRequest(`${id} isn't one of ${agent.name}'s queued assignments.`);
      if (seen.has(id)) throw badRequest(`${id} is listed twice.`);
      seen.add(id);
    }
    const order = [...orderedIds.map((id) => byId.get(id)!), ...queue.filter((a) => !seen.has(a.id))];
    const base = queue.length ? Math.min(...queue.map((a) => a.position)) : 0;
    const ts = nowIso();
    return this.world.db.transaction(() => order.map((a, i) => (a.position === base + i ? a : this.world.assignments.upsert({ ...a, position: base + i, updatedAt: ts }))))();
  }
  /** POST /assignments/:id/start-next: front of the queue; a stopped agent is resumed (runs now), a working one runs it after the current session. */
  startNext(actor: Actor, assignmentId: string): StartNextResult {
    const { a, agent } = this.controlAssignment(actor, assignmentId);
    if (a.status !== "pending") throw new AppError("conflict", `Assignment "${a.title}" is ${a.status}, not queued.`);
    if (agent.status === "banned" || agent.status === "retired") throw new AppError("conflict", `${agent.name} is ${agent.status === "retired" ? "dismissed" : "banned"}.`);
    // starting it by hand overrides what it waits on
    const assignment = moveToFront(this.world, a.waitFor ? this.world.assignments.upsert({ ...a, waitFor: null, updatedAt: nowIso() }).id : a.id);
    // manager forks: building-queue work runs as the next fork (when a desk is free), never as the manager holding it
    if (a.queue === "building") return { assignment, agent, when: "now" };
    const resumed = agent.status === "stopped" ? this.world.setStatus(agent.id, "idle", `${agent.name} was resumed to start "${a.title}"`) : agent;
    const busy = resumed.status === "working" || resumed.status === "in-meeting";
    return { assignment, agent: resumed, when: busy ? "after-current" : "now" };
  }
  /** POST /assignments/:id/cancel: pending only (the running one is ended with Stop; done/cancelled are terminal). */
  cancelAssignment(actor: Actor, assignmentId: string): Assignment {
    const { a } = this.controlAssignment(actor, assignmentId);
    if (a.status !== "pending") throw new AppError("conflict", a.status === "active" ? `"${a.title}" is running: stop the agent to end it.` : `Assignment "${a.title}" is already ${a.status}.`);
    return setAssignmentStatus(this.world, a.id, "cancelled");
  }
  /** POST /assignments/:id/retry: a cancelled or done assignment → a new pending copy (`fromAssignmentId`), at the front when `front`. */
  retryAssignment(actor: Actor, assignmentId: string, opts: { front?: boolean } = {}): Assignment {
    const { a, agent } = this.controlAssignment(actor, assignmentId);
    if (a.status !== "cancelled" && a.status !== "done") throw new AppError("conflict", `Only cancelled or done assignments can be retried; "${a.title}" is ${a.status}.`);
    // a retired fork's work is retried on the building queue (createAssignment hands it to the manager)
    if (agent.status === "banned" || (agent.status === "retired" && !agent.forkOf)) throw new AppError("conflict", `${agent.name} is ${agent.status === "retired" ? "dismissed" : "banned"}.`);
    return createAssignment(this.world, {
      agentId: agent.id, buildingId: a.buildingId, title: a.title, description: a.description,
      fromReportId: a.fromReportId, fromMeetingId: a.fromMeetingId, fromAssignmentId: a.id, front: !!opts.front,
      createdBy: actor ? this.world.holderOf(actor) : { kind: "system", id: "system" },
    });
  }

  // ---- talk: the tells between a human and an agent ----
  /** GET /api/agents/:id/thread: `tell`s between the agent and the user's avatar, both directions, oldest first (last `limit`). */
  thread(agentId: string, userId: string, limit = 200): ThreadMessage[] {
    const agent = this.world.agents.require(agentId, "agent");
    const avatar = this.world.agents.first("kind = 'human' AND ownerUserId = ?", [userId]);
    if (!avatar) return [];
    const rows = this.world.messages.where("kind = 'tell' AND ((fromId = ? AND toId = ?) OR (fromId = ? AND toId = ?))",
      [avatar.id, agent.id, agent.id, avatar.id], `ORDER BY createdAt DESC, rowid DESC LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`);
    return rows.reverse().map((m) => ({ id: m.id, fromId: m.fromId, toId: m.toId, from: this.world.nameOf(m.fromId), mine: m.fromId === avatar.id, body: m.body, at: m.createdAt }));
  }

  requireAgentControl(actor: Agent, agent: Agent): void {
    const h = this.world.holderOf(actor);
    const owner = h.kind === "user" && agent.ownerUserId === h.id;
    if (!owner && !this.world.permissions.can(actor, "building.assign", homeOf(agent))) throw forbidden("building.assign");
  }

  /** Runtime: a session starts. Work sessions activate the assignment and set status `working`; manage sessions set `working` too. */
  startSession(agentId: string, opts: { purpose: Session["purpose"]; model: string; assignmentId?: string | null; meetingId?: string | null; backend?: Session["backend"]; funding?: Session["funding"]; inputId?: string | null; credentialInputId?: string | null; size?: Pick<Session, "cpuKind" | "cpus" | "memoryMb"> | null }): Session {
    const agent = this.world.agents.require(agentId, "agent");
    const session = this.world.sessions.upsert({
      id: newId("se"), agentId, assignmentId: opts.assignmentId ?? null, meetingId: opts.meetingId ?? null, purpose: opts.purpose, backend: opts.backend ?? "host",
      status: "running", model: opts.model, sdkSessionId: null, tokens: 0, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: null,
      funding: opts.funding ?? null,
      // the Bank input whose credential the session was handed (post-mortem 2026-10-30): booked at start, never from the desk's word
      credentialInputId: opts.credentialInputId ?? null,
      bankModel: BANK_MODEL,
      // the desk Machine size it runs on (gr_uhh6u39vv9 step 3); null for host sessions and docker desks
      cpuKind: opts.size?.cpuKind ?? null, cpus: opts.size?.cpus ?? null, memoryMb: opts.size?.memoryMb ?? null,
      // goal-directed budgets: the session spends in its assignment's lane (a grant's spend is the sum of its sessions)
      ...(opts.assignmentId ? (({ lane, grantId }) => ({ lane, grantId }))(this.world.assignments.require(opts.assignmentId, "assignment")) : {}),
      // wakes step 1: the session works for its assignment's human, or for the human in its meeting (a 1:1, a mention reply)
      origin: (opts.assignmentId ? this.world.assignments.get(opts.assignmentId)?.origin : null)
        ?? (opts.meetingId ? (((m) => m && meetingOrigin(m))(this.world.meetings.get(opts.meetingId)) ?? null) : null),
    });
    if (opts.purpose === "work") {
      if (opts.assignmentId) {
        const a = this.world.assignments.require(opts.assignmentId, "assignment");
        if (a.status === "pending") setAssignmentStatus(this.world, a.id, "active");
        this.world.agents.patch(agentId, { currentAssignmentId: a.id });
      }
      this.world.setStatus(agentId, "working");
    } else if (opts.purpose === "manage") this.world.setStatus(agentId, "working"); // a manager's team-lead session (runtime/src/manage.ts)
    // member funding: `inputId` names the grant's own api-key input the session runs on (the Bank debits it first)
    const input = opts.inputId ? this.world.bank.input(opts.inputId) : undefined;
    const by = input ? `${input.label}'s API key` : opts.funding === "subscription" ? "subscription" : opts.funding === "donor-key" ? "a donor's API key" : "API key";
    this.world.events.append({ type: "session.started", agentId, buildingId: homeOf(agent), text: `${agent.name} started a ${opts.purpose} session${opts.funding ? ` (funded by ${by})` : ""}`, payload: { sessionId: session.id, purpose: opts.purpose, assignmentId: opts.assignmentId ?? null, model: opts.model, backend: session.backend, funding: opts.funding ?? null, inputId: opts.inputId ?? null, credentialInputId: opts.credentialInputId ?? null, grantId: session.grantId ?? null, origin: session.origin ?? null, ...(agent.forkOf ? { forkOf: agent.forkOf } : {}) } });
    return session;
  }

  /**
   * Runtime: a session ended. A work session still `working` (no report) leaves the agent idle. Does not charge; call budget.charge.
   * `counts` are the five token counters; a bare `tokens` (no breakdown) is split by the back-fill rule for the session's model.
   */
  endSession(sessionId: string, result: { status: Exclude<Session["status"], "running">; counts?: TokenCounts; byModel?: Record<string, TokenCounts>; tokens?: number; costUsd?: number; turns?: number; error?: string | null; sdkSessionId?: string | null; funding?: Session["funding"]; spendLimit?: string | null; wallMs?: number; cpuMs?: number; stealMs?: number }): Session {
    const s = this.world.sessions.require(sessionId, "session");
    const counts = result.counts ? countsOf(result.counts) : result.tokens !== undefined ? splitRaw(result.tokens, s.model) : countsOf(s);
    const endedAt = nowIso();
    // performance (gr_uhh6u39vv9): a desk posts wall/cpu/steal from its /proc/stat; otherwise wall is endedAt − startedAt
    const wallMs = result.wallMs ?? Math.max(0, Date.parse(endedAt) - Date.parse(s.startedAt));
    const session = this.world.sessions.upsert({
      ...s, ...counts, status: result.status, costUsd: result.costUsd ?? s.costUsd, turns: result.turns ?? s.turns,
      error: result.error ?? null, sdkSessionId: result.sdkSessionId ?? s.sdkSessionId, endedAt, funding: result.funding ?? s.funding ?? null,
      byModel: result.byModel && Object.keys(result.byModel).length ? result.byModel : s.byModel ?? null,
      wallMs: Number.isFinite(wallMs) ? Math.round(wallMs) : null, cpuMs: result.cpuMs ?? null, stealMs: result.stealMs ?? null,
    });
    const agent = this.world.agents.require(s.agentId, "agent");
    // a 1:1 answered beside a work session ends while the work goes on (and vice versa): idle only when neither runs
    if (agent.status === "working" && !this.world.sessions.count("agentId = ? AND status = 'running' AND purpose IN ('work', 'manage')", [agent.id])) this.world.setStatus(agent.id, "idle");
    clearAgentDrafting(this.world, agent.id);
    this.world.events.append({ type: "session.ended", agentId: agent.id, buildingId: homeOf(agent), text: `${agent.name}'s ${s.purpose} session ended (${result.status})`, payload: { sessionId, status: result.status, model: session.model, tokens: session.tokens, ...countsOf(session), ...(result.byModel ? { byModel: result.byModel } : {}), adjustedOutputTokens: sessionView(session).adjustedOutputTokens, costUsd: session.costUsd, turns: session.turns, reportId: session.reportId, error: session.error, ...(agent.forkOf ? { forkOf: agent.forkOf } : {}) } });
    // Bank step 4: a subscription-cap death (the desk's SPEND_LIMIT, or an error that reads like one) → bank.cap
    const cap = result.spendLimit || (session.error && SPEND_LIMIT.test(session.error) ? session.error : null);
    if (cap) this.world.bank.recordCap(session, homeOf(agent), cap);
    // the body goes back to its desk unless it's in a meeting, walking or talking (flag dc_ihwq7bfi4o)
    walkHome(this.world, agent.id);
    // Bank step 2: a model the price table doesn't know is priced as Opus 5.5; say so once per model per process
    const unknown = unknownModels(session.model, session.byModel).filter((m) => !warnedModels.has(m));
    if (unknown.length) {
      for (const m of unknown) warnedModels.add(m);
      this.world.events.append({ type: "system", agentId: agent.id, buildingId: homeOf(agent), text: `Bank: no list price for ${unknown.join(", ")}; its tokens are priced as Opus 5.5 (add it to TOKEN_PRICES in core/src/bank.ts)`, payload: { warning: "unknown-model", models: unknown, sessionId } });
    }
    return session;
  }

  /** Latest session for an agent (running first). */
  currentSession(agentId: string): Session | undefined {
    return this.world.sessions.first("agentId = ?", [agentId], "ORDER BY (status = 'running') DESC, startedAt DESC, rowid DESC");
  }

  // ---- interrupts (queued for sessions that run outside the server process, i.e. desks) ----
  /** Queue `text` for the agent's running session (or its next one if none is running). */
  enqueueInterrupt(agentId: string, text: string, from: string, now = false): Interrupt {
    const agent = this.world.agents.require(agentId, "agent");
    const running = this.world.sessions.first("agentId = ? AND status = 'running' AND purpose = 'work'", [agentId], "ORDER BY startedAt DESC, rowid DESC");
    const it = this.world.interrupts.upsert({ id: newId("in"), agentId, sessionId: running?.id ?? null, text, from, now, createdAt: nowIso(), deliveredAt: null });
    this.world.events.append({ type: "system", agentId, buildingId: homeOf(agent), text: `Interrupt for ${agent.name}: ${text.slice(0, 200)}`, payload: { sessionId: it.sessionId, interrupt: true, queued: true, interruptId: it.id, text, now } });
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
   * A request is open to every human as soon as an agent files it (no approval step); the human decides whether to do it.
   * claim: any human (avatar). done: the claimer (or admin) with `body` → creates a `human-report` in the library.
   * delete: a moderator (town.approve_request) removes a request that misuses the town; returns `request: null`.
   */
  requestAction(actor: Agent, docId: string, action: RequestAction, body?: string): { request: Doc | null; humanReport: Doc | null } {
    const doc = this.world.docs.require(docId, "doc");
    if (doc.type !== "request") throw badRequest(`Doc ${docId} is not a request.`);
    const h = this.world.holderOf(actor);
    const need = (from: Doc["requestStatus"][]) => {
      if (!from.includes(doc.requestStatus)) throw new AppError("conflict", `Request is ${doc.requestStatus}; can't ${action}.`);
    };
    let humanReport: Doc | null = null;
    let patch: Partial<Doc>;
    switch (action) {
      case "delete": {
        this.world.permissions.require(actor, "town.approve_request");
        this.world.docs.delete(doc.id);
        this.world.events.append({ type: "doc.updated", buildingId: doc.buildingId, agentId: doc.authorKind === "agent" ? doc.authorId : null, text: `${this.world.nameOf(h.id)} deleted the request "${doc.title}"`, payload: { docId: doc.id, deleted: true, by: h.id } });
        if (doc.authorKind === "agent") sendMessage(this.world, { kind: "system", fromId: h.id, fromKind: "system", toId: doc.authorId, body: `A moderator deleted your outbox request "${doc.title}".` });
        return { request: null, humanReport: null };
      }
      case "claim":
        if (h.kind !== "user") throw badRequest("Only humans can claim requests.");
        need(["open"]);
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
    const updated = this.world.events.append({ type: "doc.updated", buildingId: doc.buildingId, agentId: doc.authorKind === "agent" ? doc.authorId : null, text: `Request "${doc.title}" is ${request.requestStatus}`, payload: { docId: doc.id, requestStatus: request.requestStatus, by: h.id, ...(humanReport ? { humanReportId: humanReport.id } : {}) } });
    // wakes step 5: the answer reaches the requester (interrupt if working, else a pending directed assignment)
    if (humanReport) requestAnswerWake(this.world, request, humanReport, updated);
    return { request, humanReport };
  }

  /** Outbox: open and claimed requests (what humans can act on). */
  outbox(includeAll = false): Doc[] {
    return includeAll
      ? this.world.docs.where("type = 'request'", [], "ORDER BY createdAt DESC")
      : this.world.docs.where("type = 'request' AND requestStatus IN ('open','claimed')", [], "ORDER BY createdAt DESC");
  }

  // ---- meetings ----
  createMeeting(actor: Actor, input: (typeof CreateMeetingInput)["_input"]): Meeting { return createMeeting(this.world, input, actor ?? undefined); }
  setMeetingPhase(meetingId: string, phase: Meeting["phase"]): Meeting { return setMeetingPhase(this.world, meetingId, phase); }
  /** POST /buildings/:id/one-on-one: a human opens (or returns to) their 1:1 with the building's manager agent. */
  openOneOnOne(actor: Agent, buildingId: string, opts: { agentId?: string; docId?: string; grantId?: string; goalId?: string } = {}): Meeting { return createOneOnOne(this.world, actor, buildingId, opts); }
  /** POST /meetings/:id/start → discussing. */
  startMeeting(actor: Actor, meetingId: string): Meeting {
    const m = this.world.meetings.require(meetingId, "meeting");
    if (actor && m.facilitatorId !== actor.id && !this.world.permissions.can(actor, "meeting.facilitate", m.buildingId ?? "town-hall") && !this.world.permissions.can(actor, "building.review", m.buildingId ?? "town-hall")) throw forbidden("meeting.facilitate");
    return setMeetingPhase(this.world, meetingId, "discussing");
  }
  meetingSay(actor: Agent, meetingId: string, text: string, attach?: string): Meeting { return meetingSpeak(this.world, actor, meetingId, text, attach); }
  /** POST /meetings/:id/present: show a deck's slide above every attendee's chat (null docId stops presenting). */
  meetingPresent(actor: Agent, meetingId: string, docId: string | null, slide?: number): Meeting { return presentSlide(this.world, actor, meetingId, docId, slide); }
  /** A grant decided on a slide presented in a live meeting: also one of the meeting's decisions. */
  slideGrantDecision(actor: Actor, meetingId: string, grantId: string, action: string): Meeting | null {
    const g = this.world.grants.get(grantId);
    const past: Record<string, string> = { fund: "funded", counter: "countered", reject: "rejected", continue: "continued", adjust: "adjusted", cut: "cut" };
    return recordSlideDecision(this.world, meetingId, `${actor?.name ?? "The town"} ${past[action] ?? action} ${grantId}${g ? ` "${g.objective}"` : ""}`);
  }
  /** A report archived on a slide presented in a live meeting: also one of the meeting's decisions. */
  slideArchiveDecision(actor: Actor, meetingId: string, docId: string): Meeting | null {
    const d = this.world.docs.get(docId);
    return recordSlideDecision(this.world, meetingId, `${actor?.name ?? "The town"} archived ${docId}${d ? ` "${d.title}"` : ""}`);
  }
  /** POST /meetings/:id/typing: a human has an unsent message in the say box; agents may not end the meeting meanwhile. */
  meetingTyping(actor: Agent, meetingId: string): void {
    const m = this.world.meetings.require(meetingId, "meeting");
    if (m.phase === "discussing" && this.world.holderOf(actor).kind === "user") noteHumanTyping(this.world, m.id);
  }
  /** Agents writing a reply or decisions right now (the panel's "is writing…"). */
  meetingDrafting(meetingId: string): { id: string; name: string }[] {
    this.world.meetings.require(meetingId, "meeting");
    return agentsDrafting(this.world, meetingId).map((id) => ({ id, name: this.world.nameOf(id) }));
  }
  meetingDecide(actor: Actor, meetingId: string, decisions: Meeting["decisions"]): Meeting { return meetingDecide(this.world, actor, meetingId, decisions); }
  /** `actor` null = the town itself; `cause` names why ("facilitation-end"), recorded in the meeting.phase event. */
  endMeeting(actor: Actor, meetingId: string, closing?: string, cause?: string): Meeting {
    if (actor) {
      const m = this.world.meetings.require(meetingId, "meeting");
      if (m.facilitatorId !== actor.id && !this.world.permissions.can(actor, "meeting.facilitate", m.buildingId ?? "town-hall") && !this.world.permissions.can(actor, "building.review", m.buildingId ?? "town-hall")) throw forbidden("meeting.facilitate");
    }
    return endMeeting(this.world, null, meetingId, closing, actor ? this.world.holderOf(actor) : { kind: "system", id: cause ?? "town" });
  }
}
