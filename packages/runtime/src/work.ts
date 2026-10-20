/** Resident work sessions (host backend + shared end-of-session logic), interrupts, and reviewer sessions over the in-tray. */
import { AppError, buildingRoleId, createDoc, fallbackReportBody, latestReportOf, reviewPrompt, reviewSystemPrompt, setAssignmentStatus, updateDoc, workPrompt, workSystemPrompt } from "@agent-town/core";
import type { Agent, Assignment, Building, Doc, Session } from "@agent-town/schema";
import { chargeUsage, fundingFor, homeOf, runAgentSession, type Ctx } from "./session.ts";

const REVIEW_MAX_TURNS = 10;

export function latestReport(ctx: Ctx, agentId: string): Doc | undefined {
  return latestReportOf(ctx.world, agentId);
}

/** Walk the body back to its desk (fire and forget; the session doesn't wait for the walk). */
export function walkToDesk(ctx: Ctx, agent: Agent): void {
  const desk = ctx.world.layout.deskOf(agent.id);
  if (!desk || (desk.pos.x === agent.pos.x && desk.pos.y === agent.pos.y)) return;
  // A leftover walk (e.g. to the meeting room) must not keep the body away from the desk during a work session.
  if (ctx.world.movement.isWalking(agent.id)) ctx.world.movement.cancel(agent.id, "Heading back to the desk to work.");
  ctx.world.movement.go(ctx.world.agents.get(agent.id) ?? agent, desk.pos, desk.name).catch(() => undefined);
}

/**
 * Checks shared by both backends before a work session starts. Throws `conflict` if the agent is already
 * in a session or can't work, `out_of_budget`-style conflict if it can't start.
 */
export function preflightWork(ctx: Ctx, starting: Set<string>, agentId: string, assignmentId: string): { agent: Agent; building: Building; assignment: Assignment } {
  const { world } = ctx;
  if (starting.has(agentId) || ctx.live.has(agentId)) throw new AppError("conflict", "Agent is already in a work session.");
  const agent = world.agents.require(agentId, "agent");
  if (agent.status === "banned" || agent.status === "stopped" || agent.status === "retired") throw new AppError("conflict", `${agent.name} is ${agent.status}.`);
  const bid = homeOf(world, agentId);
  if (!bid) throw new AppError("bad_request", `${agent.name} has no building.`);
  if (!world.budget.canStart(agentId)) {
    if (agent.kind === "resident") world.setStatus(agentId, "out-of-budget");
    throw new AppError("conflict", `${agent.name} is out of budget.`);
  }
  return { agent, building: world.buildings.require(bid, "building"), assignment: world.assignments.require(assignmentId, "assignment") };
}

/**
 * Host backend: run one in-process work session for `agentId` on `assignmentId`. Resolves with the ended session.
 * Buildings with a workspace need a desk (docker backend); the host backend refuses them.
 */
export async function runWorkSession(ctx: Ctx, starting: Set<string>, agentId: string, assignmentId: string): Promise<Session> {
  const { world } = ctx;
  const { agent, building, assignment } = preflightWork(ctx, starting, agentId, assignmentId);
  if (building.workspace) throw new AppError("conflict", `${building.name} has a code workspace; its residents need a desk (docker backend).`);
  starting.add(agentId);
  try {
    walkToDesk(ctx, agent);
    const out = await runAgentSession(ctx, {
      agentId, purpose: "work", model: agent.model ?? building.model, maxTurns: building.maxTurnsPerSession, web: true,
      assignmentId, system: workSystemPrompt(agent, building, world.town.get()), prompt: workPrompt(assignment, latestReport(ctx, agentId)),
      finish: (o, allocationId) => finishWorkSession(ctx, o.session.id, { ...o }, allocationId),
    });
    return out.session;
  } finally {
    starting.delete(agentId);
  }
}

/** How a work session ended, from either backend (the desk posts this to /api/agents/me/session-end). */
export interface WorkOutcome {
  tokens?: number;
  costUsd?: number;
  turns?: number;
  sdkSessionId?: string | null;
  finalText?: string | null;
  error?: string | null;
  reportSubmitted?: boolean;
  /** the runtime aborted it (agent stopped/banned/retired or runtime shutdown) */
  stopped?: boolean;
  /** merge=green desks: whether the PR was merged after the checks (absent = no merge attempted) */
  merged?: boolean;
  prNumber?: number;
}

/** The line finishWorkSession appends to the report when a desk attempted a green merge. */
export function mergeLine(o: Pick<WorkOutcome, "merged" | "prNumber">): string | null {
  if (o.merged === undefined && o.prNumber === undefined) return null;
  if (o.merged) return o.prNumber ? `Merged as PR #${o.prNumber}` : "Merged";
  return o.prNumber ? `PR #${o.prNumber} open, checks failed` : "PR left open, checks failed";
}

/**
 * End a work session (both backends): write the fallback report when none was submitted (stop → decision
 * stop + assignment cancelled), end the Session row (agent status transitions, `session.ended`), charge usage.
 * Idempotent: a session that already ended is returned unchanged.
 */
export async function finishWorkSession(ctx: Ctx, sessionId: string, o: WorkOutcome, allocationId?: string | null): Promise<Session> {
  const { world } = ctx;
  const session = world.sessions.require(sessionId, "session");
  if (session.status !== "running") return session;
  const agentId = session.agentId;
  const bid = homeOf(world, agentId);
  const live = ctx.live.get(agentId);
  const agentNow = world.agents.require(agentId, "agent");
  const stopped = !!o.stopped || (live?.sessionId === sessionId && live.stopped) || agentNow.status === "stopped" || agentNow.status === "banned" || agentNow.status === "retired";
  const usage = { tokens: Math.max(0, Math.round(o.tokens ?? 0)), costUsd: Math.max(0, o.costUsd ?? 0), turns: Math.max(0, Math.round(o.turns ?? 0)) };
  const error = o.error ?? null;
  const reportSubmitted = !!o.reportSubmitted || !!world.sessions.get(sessionId)?.reportId;

  if (session.purpose === "work" && !reportSubmitted) {
    try {
      const assignment = session.assignmentId ? world.assignments.get(session.assignmentId) : undefined;
      const body = fallbackReportBody(o.finalText ?? "", error, assignment);
      const title = `Session ended without a report: ${assignment?.title ?? "work session"}`.slice(0, 200);
      if (stopped) {
        const doc = createDoc(world, {
          type: "report", state: "building", title, body, verdict: "continue", decision: "stop", decidedBy: "system", decidedAt: new Date().toISOString(),
          decisionNote: `${agentNow.name} was ${agentNow.status === "banned" || agentNow.status === "stopped" ? agentNow.status : agentNow.status === "retired" ? "dismissed" : "stopped"} during the session.`,
          authorId: agentId, authorKind: "agent", buildingId: bid, sessionId, assignmentId: session.assignmentId ?? undefined,
        }, `${agentNow.name}'s session was stopped; fallback report written`);
        world.sessions.patch(sessionId, { reportId: doc.id });
        if (session.assignmentId && world.assignments.get(session.assignmentId)?.status === "active") setAssignmentStatus(world, session.assignmentId, "cancelled", { reportId: doc.id });
        world.agents.patch(agentId, { currentAssignmentId: null });
      } else {
        await world.verbs.submit_report(agentId, { title, body, verdict: "continue" });
        world.events.append({ type: "system", agentId, buildingId: bid, text: `${agentNow.name}'s session ended without a report; fallback report written`, payload: { sessionId, fallback: true } });
      }
    } catch (e) {
      world.events.append({ type: "system", agentId, buildingId: bid, text: `Runtime error after session: ${e instanceof Error ? e.message : String(e)}`, payload: { sessionId } });
    }
  }
  const line = mergeLine(o);
  const reportId = world.sessions.get(sessionId)?.reportId;
  if (line && reportId) {
    const doc = world.docs.get(reportId);
    if (doc) {
      updateDoc(world, doc.id, { body: `${doc.body.trimEnd()}\n\n${line}\n` });
      world.events.append({ type: "doc.updated", agentId, buildingId: doc.buildingId, text: `${agentNow.name}: ${line}`, payload: { docId: doc.id, merged: !!o.merged, prNumber: o.prNumber ?? null } });
    }
  }
  const status: Exclude<Session["status"], "running"> = stopped ? "interrupted" : error ? "error" : "done";
  const ended = world.ops.endSession(sessionId, { status, ...usage, error, sdkSessionId: o.sdkSessionId ?? null });
  chargeUsage(world, agentId, usage, allocationId !== undefined ? allocationId : ctx.deskAllocations.get(sessionId) ?? fundingFor(world, agentId).allocationId);
  ctx.deskAllocations.delete(sessionId);
  return ended;
}

/** Deliver `text` as the next user message of the agent's running work session. */
export function interrupt(ctx: Ctx, agentId: string, text: string, from = "A human"): boolean {
  const live = ctx.live.get(agentId);
  // desk sessions take interrupts through the queue (GET /api/agents/me/control)
  if (!live || live.kind !== "host" || live.stopped || live.reportSubmitted || live.input.closed) return false;
  const ok = live.input.push(`Interrupt from ${from}: ${text}\n\nTake this into account now, then continue. You must still finish with submit_report.`);
  if (ok) {
    const a = ctx.world.agents.get(agentId);
    ctx.world.events.append({ type: "system", agentId, buildingId: a ? a.homeBuildingId ?? a.buildingId : null, text: `Interrupt for ${a?.name ?? agentId}: ${text.slice(0, 200)}`, payload: { sessionId: live.sessionId, interrupt: true, text } });
  }
  return ok;
}

/**
 * Stop a live work session (agent was stopped/banned, or the runtime is shutting down). Host: interrupt the
 * query. Desk: the control endpoint already says `stop: true`; kill the child after `graceMs` if it's still running.
 */
export function abortWork(ctx: Ctx, agentId: string, graceMs = 0): void {
  const live = ctx.live.get(agentId);
  if (!live) return;
  live.stopped = true;
  live.input.close();
  void live.q?.interrupt?.()?.catch(() => undefined);
  if (live.child) {
    const child = live.child;
    if (graceMs <= 0) child.kill();
    else setTimeout(() => { if (ctx.live.get(agentId) === live) child.kill(); }, graceMs).unref?.();
  }
}

/** The building's reviewer agent able to review `doc` (not its author), if any. */
export function reviewerFor(ctx: Ctx, buildingId: string, exclude?: string): Agent | undefined {
  return ctx.world.permissions.agentsWithRole(buildingRoleId(buildingId, "reviewer"))
    .map((id) => ctx.world.agents.get(id))
    .find((a): a is Agent => !!a && a.kind !== "human" && a.id !== exclude && a.status !== "banned" && a.status !== "stopped" && a.status !== "retired");
}

/**
 * If `docId` is a pending report in a `reviewer`-policy building, run a short review session for the
 * building's reviewer over that in-tray item (it may approve, continue, redirect or stop). Each report is
 * reviewed at most once per runtime; undecided → left in the in-tray for the manager.
 */
export async function maybeReview(ctx: Ctx, reviewed: Set<string>, docId: string): Promise<boolean> {
  const { world } = ctx;
  if (reviewed.has(docId)) return false;
  const doc = world.docs.get(docId);
  if (!doc || doc.type !== "report" || doc.decision !== "pending" || !doc.buildingId) return false;
  const building = world.buildings.get(doc.buildingId);
  if (!building || building.reviewPolicy !== "reviewer") return false;
  const mod = reviewerFor(ctx, building.id, doc.authorId);
  const author = world.agents.get(doc.authorId);
  if (!mod || !author || !world.budget.canStart(mod.id)) return false;
  reviewed.add(docId);
  const assignment = doc.assignmentId ? world.assignments.get(doc.assignmentId) : undefined;
  const board = world.docs.where("buildingId = ? AND state = 'building' AND id != ?", [building.id, doc.id], "ORDER BY updatedAt DESC LIMIT 20");
  await runAgentSession(ctx, {
    agentId: mod.id, purpose: "review", model: mod.model ?? building.model, maxTurns: REVIEW_MAX_TURNS, web: false,
    assignmentId: null, system: reviewSystemPrompt(mod, building), prompt: reviewPrompt(doc, author, assignment, building, board),
  });
  const after = world.docs.get(docId);
  if (after?.decision === "pending") {
    world.events.append({ type: "system", agentId: mod.id, buildingId: building.id, text: `${mod.name} didn't decide on "${doc.title}"; it stays in the in-tray`, payload: { docId } });
  }
  return true;
}
