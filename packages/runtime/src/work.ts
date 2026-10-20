import { execSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
/** Resident work sessions (with fallback report + interrupts) and moderator review sessions. */
import { AppError, buildingRoleId, createDoc, setAssignmentStatus } from "@agent-town/core";
import type { Agent, Assignment, Building, Doc, Session } from "@agent-town/schema";
import { fallbackReportBody, reviewPrompt, reviewSystemPrompt, workPrompt, workSystemPrompt, workshopPrompt } from "./prompts.ts";
import { homeOf, runAgentSession, type Ctx } from "./session.ts";

const REVIEW_MAX_TURNS = 10;

export function latestReport(ctx: Ctx, agentId: string): Doc | undefined {
  return ctx.world.docs.first("authorId = ? AND type = 'report'", [agentId], "ORDER BY createdAt DESC, rowid DESC");
}

/** Walk the body back to its desk (fire and forget; the session doesn't wait for the walk). */
function walkToDesk(ctx: Ctx, agent: Agent): void {
  const desk = ctx.world.layout.deskOf(agent.id);
  if (!desk || (desk.pos.x === agent.pos.x && desk.pos.y === agent.pos.y)) return;
  // A leftover walk (e.g. to the meeting room) must not keep the body away from the desk during a work session.
  if (ctx.world.movement.isWalking(agent.id)) ctx.world.movement.cancel(agent.id, "Heading back to the desk to work.");
  ctx.world.movement.go(ctx.world.agents.get(agent.id) ?? agent, desk.pos, desk.name).catch(() => undefined);
}

/**
 * Run one work session for `agentId` on `assignmentId`. Resolves with the ended session.
 * Throws `conflict` if the agent is already in a session, `out_of_budget` if it can't start.
 */
export async function runWorkSession(ctx: Ctx, starting: Set<string>, agentId: string, assignmentId: string): Promise<Session> {
  const { world } = ctx;
  if (starting.has(agentId) || ctx.live.has(agentId)) throw new AppError("conflict", "Agent is already in a work session.");
  const agent = world.agents.require(agentId, "agent");
  if (agent.status === "banned" || agent.status === "stopped") throw new AppError("conflict", `${agent.name} is ${agent.status}.`);
  const bid = homeOf(world, agentId);
  if (!bid) throw new AppError("bad_request", `${agent.name} has no building.`);
  if (!world.budget.canStart(agentId)) {
    if (agent.kind === "resident") world.setStatus(agentId, "out-of-budget");
    throw new AppError("conflict", `${agent.name} is out of budget.`);
  }
  const building = world.buildings.require(bid, "building");
  const assignment = world.assignments.require(assignmentId, "assignment");
  starting.add(agentId);
  try {
    walkToDesk(ctx, agent);
    const ws = building.workspace ? prepareWorkspace(ctx, building.workspace, agent, assignment) : undefined;
    if (ws) world.events.append({ type: "agent.activity", agentId, buildingId: bid, text: `${agent.name} checked out branch ${ws.branch}`, payload: { branch: ws.branch, cwd: ws.cwd } });
    const out = await runAgentSession(ctx, {
      agentId, purpose: "work", model: agent.model ?? building.model, maxTurns: building.maxTurnsPerSession, web: true,
      workspace: ws ? { cwd: ws.cwd, branch: ws.branch, tools: building.workspace!.tools } : undefined,
      assignmentId, system: workSystemPrompt(agent, building, world.town.get()) + (ws ? workshopPrompt(ws, ws.repoName) : ""), prompt: workPrompt(assignment, latestReport(ctx, agentId)),
      beforeEnd: async (o) => {
        if (o.reportSubmitted) return;
        const now = world.agents.require(agentId);
        const body = fallbackReportBody(o.finalText, o.error, assignment);
        const title = `Session ended without a report: ${assignment.title}`.slice(0, 200);
        if (o.stopped || now.status === "stopped" || now.status === "banned") {
          const doc = createDoc(world, {
            type: "report", state: "building", title, body, verdict: "continue", decision: "stop", decidedBy: "system", decidedAt: new Date().toISOString(),
            decisionNote: `${now.name} was ${now.status} during the session.`, authorId: agentId, authorKind: "agent", buildingId: bid, sessionId: o.session.id, assignmentId,
          }, `${now.name}'s session was stopped; fallback report written`);
          world.sessions.patch(o.session.id, { reportId: doc.id });
          if (world.assignments.get(assignmentId)?.status === "active") setAssignmentStatus(world, assignmentId, "cancelled", { reportId: doc.id });
          world.agents.patch(agentId, { currentAssignmentId: null });
          return;
        }
        await world.verbs.submit_report(agentId, { title, body, verdict: "continue" });
        world.events.append({ type: "system", agentId, buildingId: bid, text: `${now.name}'s session ended without a report; fallback report written`, payload: { sessionId: o.session.id, fallback: true } });
      },
    });
    return out.session;
  } finally {
    starting.delete(agentId);
  }
}

/** Deliver `text` as the next user message of the agent's running work session. */
export function interrupt(ctx: Ctx, agentId: string, text: string, from = "A human"): boolean {
  const live = ctx.live.get(agentId);
  if (!live || live.stopped || live.reportSubmitted || live.input.closed) return false;
  const ok = live.input.push(`Interrupt from ${from}: ${text}\n\nTake this into account now, then continue. You must still finish with submit_report.`);
  if (ok) {
    const a = ctx.world.agents.get(agentId);
    ctx.world.events.append({ type: "system", agentId, buildingId: a ? a.homeBuildingId ?? a.buildingId : null, text: `Interrupt for ${a?.name ?? agentId}: ${text.slice(0, 200)}`, payload: { sessionId: live.sessionId, interrupt: true, text } });
  }
  return ok;
}

/** Stop a live work session (agent was stopped/banned). */
export function abortWork(ctx: Ctx, agentId: string): void {
  const live = ctx.live.get(agentId);
  if (!live) return;
  live.stopped = true;
  live.input.close();
  void live.q?.interrupt?.()?.catch(() => undefined);
}

/** The building's moderator agent able to review `doc` (not its author), if any. */
export function moderatorFor(ctx: Ctx, buildingId: string, exclude?: string): Agent | undefined {
  return ctx.world.permissions.agentsWithRole(buildingRoleId(buildingId, "moderator"))
    .map((id) => ctx.world.agents.get(id))
    .find((a): a is Agent => !!a && a.kind !== "human" && a.id !== exclude && a.status !== "banned" && a.status !== "stopped");
}

/**
 * If `docId` is a pending report in a `moderator`-policy building, run a review session for the
 * building's moderator. Each report is reviewed at most once per runtime; undecided → left for humans.
 */
export async function maybeReview(ctx: Ctx, reviewed: Set<string>, docId: string): Promise<boolean> {
  const { world } = ctx;
  if (reviewed.has(docId)) return false;
  const doc = world.docs.get(docId);
  if (!doc || doc.type !== "report" || doc.decision !== "pending" || !doc.buildingId) return false;
  const building = world.buildings.get(doc.buildingId);
  if (!building || building.reviewPolicy !== "moderator") return false;
  const mod = moderatorFor(ctx, building.id, doc.authorId);
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
    world.events.append({ type: "system", agentId: mod.id, buildingId: building.id, text: `${mod.name} didn't decide on "${doc.title}"; it's waiting for a human`, payload: { docId } });
  }
  return true;
}

/** Slug for branch and directory names. */
function slug(x: string, n = 40): string {
  return x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n) || "work";
}

/**
 * Give the agent its own git worktree for this assignment (created on first use, reused after):
 * <repo>/work/<agent>-<assignment6> on branch <prefix>/<agent>/<slug>, forked from the base branch.
 * The root node_modules is symlinked in so typecheck/tests run without an install.
 */
function prepareWorkspace(ctx: Ctx, ws: NonNullable<Building["workspace"]>, agent: Agent, assignment: Assignment): { cwd: string; branch: string; base: string; repoName: string } {
  const repo = resolve(ctx.repoRoot, ws.path);
  const branch = `${ws.branchPrefix}/${slug(agent.name, 20)}/${slug(assignment.title)}`;
  const dir = join(repo, "work", `${slug(agent.name, 20)}-${assignment.id.slice(-6)}`);
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  if (!existsSync(dir)) {
    git(`fetch --quiet origin ${ws.base}`);
    const exists = git(`branch --list ${branch}`) !== "";
    git(`worktree add --quiet ${exists ? "" : `-b ${branch}`} ${JSON.stringify(dir)} ${exists ? branch : `origin/${ws.base}`}`);
  }
  const nm = join(dir, "node_modules");
  if (!existsSync(nm) && existsSync(join(repo, "node_modules"))) symlinkSync(join(repo, "node_modules"), nm, "dir");
  return { cwd: dir, branch, base: ws.base, repoName: basename(repo) };
}
