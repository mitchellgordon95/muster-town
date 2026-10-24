/**
 * The manager's team-lead session (docs/waterfall.md §3.1–3.2, build step 2): one host session per building manager
 * agent, woken by residents' reports landing in its in-tray. It decides them (`review`), assigns follow-ups (`assign`)
 * and ends with a rollup (`submit_report rollup: true`) only when one is due; otherwise it ends without a report.
 * Reports that land while it runs are streamed into it, so it keeps the context of what it already decided.
 */
import { intrayOf, managePrompt, managerAgentOf, managerNewReport, sessionMemory, skillsBlock, workSystemPrompt } from "@muster-town/core";
import type { Doc, Session } from "@muster-town/schema";
import { homeOf, runAgentSession, type Ctx } from "./session.ts";

export interface ManageState {
  /** report ids already offered to a manage session (in-memory: a restart offers the in-tray again, once) */
  offered: Set<string>;
}
export const newManageState = (): ManageState => ({ offered: new Set() });

export interface ManageGate {
  /** no new sessions (a redeploy is draining) */
  draining(): boolean;
  /** the agent's work session is starting */
  starting(agentId: string): boolean;
  /** a free host slot */
  slotFree(): boolean;
}

/**
 * Offer the building's new in-tray reports to its manager agent: stream them into its running manage session, or
 * start one if the manager is idle and can. A no-op for the Town Hall, buildings without a working manager agent, and
 * reports already offered. The manager's own reports (rollups) are Town Hall items, never in `intrayOf(building)`,
 * so a manage session can't wake itself. Returns the started session's promise, if one started.
 */
export function wakeManager(ctx: Ctx, st: ManageState, gate: ManageGate, buildingId: string): Promise<Session> | null {
  const { world } = ctx;
  const building = world.buildings.get(buildingId);
  if (!building || building.kind === "town-hall") return null;
  const mgr = managerAgentOf(world, building);
  if (!mgr || homeOf(world, mgr.id) !== building.id) return null;
  const fresh = intrayOf(world, building.id).filter((d) => !st.offered.has(d.id) && d.authorId !== mgr.id);
  if (!fresh.length) return null;
  const live = ctx.live.get(mgr.id);
  if (live) {
    // a work session (or a desk) is busy: the tick offers these once it has ended
    if (live.purpose !== "manage" || live.kind !== "host" || live.stopped || live.reportSubmitted) return null;
    for (const d of fresh) if (live.input.push(managerNewReport(d, world.nameOf.bind(world)))) st.offered.add(d.id);
    return null;
  }
  if (gate.starting(mgr.id) || mgr.status !== "idle" || gate.draining() || !gate.slotFree() || !world.budget.canStart(mgr.id)) return null;
  for (const d of fresh) st.offered.add(d.id);
  return runManageSession(ctx, mgr.id, fresh);
}

/** Run one manage session (registers in `ctx.live` synchronously, before the first await). Resolves with the ended session. */
export async function runManageSession(ctx: Ctx, agentId: string, fresh: Doc[]): Promise<Session> {
  const { world } = ctx;
  const agent = world.agents.require(agentId, "agent");
  const building = world.buildings.require(homeOf(world, agentId)!, "building");
  const nameOf = world.nameOf.bind(world);
  const out = await runAgentSession(ctx, {
    agentId, purpose: "manage", model: agent.model ?? building.model, maxTurns: building.maxTurnsPerSession, web: false,
    system: workSystemPrompt(agent, building, world.town.get(), { ...sessionMemory(world, agent, building), skills: skillsBlock(world.skills.forAgent(agentId)) }),
    prompt: managePrompt(building, fresh, nameOf),
  });
  // no fallback report for this purpose: an idle building is silent; the event log says what the session did
  const s = out.session;
  const decided = world.docs.count("type = 'report' AND decidedBy = ? AND decidedAt >= ?", [agentId, s.startedAt]);
  const rollup = s.reportId ? world.docs.get(s.reportId) : undefined;
  world.events.append({
    type: "system", agentId, buildingId: building.id,
    text: `${agent.name}'s in-tray session ended (${s.status}): decided ${decided} report${decided === 1 ? "" : "s"}, ${rollup ? `rollup "${rollup.title}"` : "no rollup"}`,
    payload: { sessionId: s.id, purpose: "manage", decided, rollupId: rollup?.id ?? null },
  });
  return s;
}
