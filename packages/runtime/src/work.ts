/** Resident work sessions (host backend + shared end-of-session logic), interrupts, and reviewer sessions over the in-tray. */
import { AppError, appendAgentLog, chainBlock, codeWorkspace, createDoc, fallbackReportBody, FALLBACK_REPORT_PREFIX, latestReportOf, recentWorkBlock, sessionMemory, sessionView, setAssignmentStatus, skillsBlock, workPrompt, workSystemPrompt } from "@muster-town/core";
import { countsOf, rawTokens, splitRaw, type Agent, type AllocationAuth, type Assignment, type Building, type Doc, type Session, type TokenCounts } from "@muster-town/schema";
import { chargeUsage, fundingFor, homeOf, runAgentSession, type Ctx } from "./session.ts";


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
  // a hosted collective with no key of its own: held, not out of budget ("No key yet")
  const keyHold = world.budget.keyHold?.();
  if (keyHold) throw new AppError("conflict", `${agent.name} is held: ${keyHold}`);
  if (!world.budget.canStart(agentId)) {
    if (agent.kind === "resident") world.setStatus(agentId, "out-of-budget");
    throw new AppError("conflict", `${agent.name} is out of budget.`);
  }
  const assignment = world.assignments.require(assignmentId, "assignment");
  // the lane gate (goal-directed buildings): a held assignment stays pending with its heldReason; the agent isn't out of budget
  if (!world.budget.canStart(agentId, assignment)) throw new AppError("conflict", `${agent.name}'s assignment is ${world.assignments.get(assignment.id)?.heldReason ?? "held"}.`);
  return { agent, building: world.buildings.require(bid, "building"), assignment };
}

/**
 * Host backend: run one in-process work session for `agentId` on `assignmentId`. Resolves with the ended session.
 * Buildings with code access need a desk (docker backend); the host backend refuses them.
 */
export async function runWorkSession(ctx: Ctx, starting: Set<string>, agentId: string, assignmentId: string): Promise<Session> {
  const { world } = ctx;
  const { agent, building, assignment } = preflightWork(ctx, starting, agentId, assignmentId);
  if (codeWorkspace(world.town.get(), building)) throw new AppError("conflict", `${building.name} has code access; its residents need a desk (docker backend).`);
  starting.add(agentId);
  try {
    walkToDesk(ctx, agent);
    const out = await runAgentSession(ctx, {
      agentId, purpose: "work", model: agent.model ?? building.model, maxTurns: building.maxTurnsPerSession, web: true,
      assignmentId, system: workSystemPrompt(agent, building, world.town.get(), { ...sessionMemory(world, agent, building, assignment), skills: skillsBlock(world.skills.forAgent(agentId)) }),
      prompt: workPrompt(assignment, latestReport(ctx, agentId), recentWorkBlock(world, agentId), agent.forkOf ? chainBlock(world, assignment) : undefined),
      finish: (o, allocationId) => finishWorkSession(ctx, o.session.id, { ...o }, allocationId),
    });
    return out.session;
  } finally {
    starting.delete(agentId);
  }
}

/** How a work session ended, from either backend (the desk posts this to /api/agents/me/session-end). */
export interface WorkOutcome {
  /** raw total: only read when `counts` is absent (an older desk), then split by the back-fill rule */
  tokens?: number;
  /** the five token counters, and per model id */
  counts?: TokenCounts;
  byModel?: Record<string, TokenCounts>;
  costUsd?: number;
  turns?: number;
  sdkSessionId?: string | null;
  finalText?: string | null;
  error?: string | null;
  reportSubmitted?: boolean;
  /** the runtime aborted it (agent stopped/banned/retired or runtime shutdown) */
  stopped?: boolean;
  /** what actually paid for it (desk session-end) */
  fundingUsed?: AllocationAuth;
  /** the desk failed over from the subscription to the fallback API key: charge the fallback allocation */
  fallback?: boolean;
  /** the SDK's message when the desk classified a result as SPEND_LIMIT (core logs `bank.cap`) */
  spendLimit?: string;
  /** desk session-end: wall ms and the Machine's CPU and steal ms over the session (/proc/stat) */
  wallMs?: number;
  cpuMs?: number;
  stealMs?: number;
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
  const counts = o.counts ? countsOf(o.counts) : splitRaw(o.tokens ?? 0, session.model);
  const usage = { tokens: rawTokens(counts), counts, costUsd: Math.max(0, o.costUsd ?? 0), turns: Math.max(0, Math.round(o.turns ?? 0)) };
  const error = o.error ?? null;
  const reportSubmitted = !!o.reportSubmitted || !!world.sessions.get(sessionId)?.reportId;

  if (session.purpose === "work" && !reportSubmitted) {
    try {
      const assignment = session.assignmentId ? world.assignments.get(session.assignmentId) : undefined;
      const body = fallbackReportBody(o.finalText ?? "", error, assignment);
      const title = `${FALLBACK_REPORT_PREFIX} ${assignment?.title ?? "work session"}`.slice(0, 200);
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
  const status: Exclude<Session["status"], "running"> = stopped ? "interrupted" : error ? "error" : "done";
  const funding = o.fundingUsed ?? (o.fallback ? "api-key" : undefined);
  // a failover is never silent: the HUD shows the latest one (`alert: funding-failover`), the log keeps them all
  if (o.fallback) {
    const fbAlloc = ctx.deskFallbacks.get(sessionId) ?? (bid ? world.budget.fallbackAllocation(bid)?.id ?? null : null);
    const paidBy = fbAlloc ? world.allocations.get(fbAlloc)?.label ?? "an API-key allocation" : "the Bank's API-key input";
    world.events.append({ type: "system", agentId, buildingId: bid, text: `${agentNow.name}'s session hit the subscription's limit and finished on the API key (${paidBy})`, payload: { alert: "funding-failover", sessionId, allocationId: fbAlloc, costUsd: usage.costUsd } });
  }
  const ended = world.ops.endSession(sessionId, { status, counts, byModel: o.byModel, costUsd: usage.costUsd, turns: usage.turns, error, sdkSessionId: o.sdkSessionId ?? null, funding, spendLimit: o.spendLimit ?? null, wallMs: o.wallMs, cpuMs: o.cpuMs, stealMs: o.stealMs });
  // stamp the session's usage onto the report it produced (submitted or fallback), in adjusted output tokens (Bank step 3)
  const adjusted = sessionView(ended).adjustedOutputTokens;
  const report = ended.reportId ? world.docs.get(ended.reportId) : undefined;
  if (report && report.sessionId === sessionId) world.docs.patch(report.id, { tokens: adjusted, costUsd: usage.costUsd, turns: usage.turns });
  // the resident's log: one line per work session, written for it (its wiki is its own job)
  if (session.purpose === "work" && agentNow.kind === "resident") {
    try {
      const asg = session.assignmentId ? world.assignments.get(session.assignmentId) : undefined;
      const what = asg ? `Assignment "${asg.title}" (${asg.id})` : "Check-in session";
      const rep = report ? `, report "${report.title}" (${report.id}, verdict ${report.verdict ?? "?"})` : ", no report";
      // a fork's line goes to its manager's log as "[Pix 3] …" (the building's journal)
      appendAgentLog(world, agentNow, `${what}: ${status}${rep}, ${adjusted.toLocaleString("en-US")} adj. tokens`);
    } catch (e) { console.warn(`[runtime] log line for ${agentNow.name}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  // the allocation that actually funded it: the fallback one when the desk failed over from the subscription
  const charged = o.fallback
    ? ctx.deskFallbacks.get(sessionId) ?? (bid ? world.budget.fallbackAllocation(bid)?.id ?? null : null)
    : allocationId !== undefined ? allocationId : ctx.deskAllocations.has(sessionId) ? ctx.deskAllocations.get(sessionId) ?? null : fundingFor(world, agentId, ctx.env).allocationId;
  chargeUsage(world, agentId, { ...usage, byModel: o.byModel ?? undefined }, charged, ended.model, ended.grantId);
  ctx.deskAllocations.delete(sessionId);
  ctx.deskFallbacks.delete(sessionId);
  return ended;
}

/**
 * Deliver `text` as the next user message of the agent's running work session. It waits for the current turn to
 * end unless `now`, which aborts the turn (the SDK keeps queued user messages across an interrupt, so it runs next).
 */
export function interrupt(ctx: Ctx, agentId: string, text: string, from = "A human", now = false): boolean {
  const live = ctx.live.get(agentId);
  // desk sessions take interrupts through the queue (GET /api/agents/me/control)
  if (!live || live.kind !== "host" || live.stopped || live.reportSubmitted || live.input.closed) return false;
  const tail = live.purpose === "manage" ? "End as before: a rollup only if one is due, else just stop." : "You must still finish with submit_report.";
  const ok = live.input.push(`Interrupt from ${from}: ${text}\n\nTake this into account now, then continue. ${tail}`);
  if (ok) {
    const a = ctx.world.agents.get(agentId);
    ctx.world.events.append({ type: "system", agentId, buildingId: a ? a.homeBuildingId ?? a.buildingId : null, text: `Interrupt for ${a?.name ?? agentId}: ${text.slice(0, 200)}`, payload: { sessionId: live.sessionId, interrupt: true, text, now } });
    if (now) void live.q?.interrupt?.()?.catch(() => undefined);
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

