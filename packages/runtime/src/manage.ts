/**
 * The manager's team-lead session (docs/waterfall.md §3.1–3.2 and §3.4, build steps 2 and 4): one host session per
 * building manager agent, woken by residents' reports landing in its in-tray or by a human opening a 1:1 with it.
 * It decides reports (`review`), assigns follow-ups (`assign`) and ends with a rollup (`submit_report rollup: true`)
 * only when one is due; otherwise it ends without a report. Reports that land and the human's 1:1 lines are streamed
 * into it, so it keeps the context of what it already decided; while a 1:1 is open it stays open between turns.
 */
import { endMeeting, humanDecisionsBlock, humanTyping, intrayOf, managePrompt, managerAgentOf, managerNewReport, meetingNotice, oneOnOneEnded, oneOnOnePrompt, oneOnOneUtterance, sessionMemory, skillsBlock, workSystemPrompt, type World } from "@muster-town/core";
import type { Agent, Doc, Meeting, Session } from "@muster-town/schema";
import { homeOf, runAgentSession, type Ctx } from "./session.ts";

export interface ManageState {
  /** report ids already offered to a manage session (in-memory: a restart offers the in-tray again, once) */
  offered: Set<string>;
  /** 1:1 meetingId → the manage session it's fed into and how much of its transcript that session has seen */
  fed: Map<string, { sessionId: string; idx: number }>;
  /** 1:1 meetingId → the busy session already announced in it (one "busy" notice per 1:1 per session) */
  busyNoticed: Map<string, string>;
}
export const newManageState = (): ManageState => ({ offered: new Set(), fed: new Map(), busyNoticed: new Map() });

/** A 1:1 nobody spoke in for this long (and nobody is typing in) is closed by the town. */
export const ONE_ON_ONE_QUIET_MS = 20 * 60_000;

/** The manager's open 1:1s. */
export const openOneOnOnes = (world: World, managerId: string): Meeting[] =>
  world.meetings.where("kind = 'one-on-one' AND facilitatorId = ? AND phase = 'discussing'", [managerId], "ORDER BY createdAt");

export interface ManageGate {
  /** no new sessions (a redeploy is draining) */
  draining(): boolean;
  /** the agent's work session is starting */
  starting(agentId: string): boolean;
  /** a free host slot */
  slotFree(): boolean;
}

/**
 * Offer the building's new in-tray reports and its open 1:1s to its manager agent: stream them into its running manage
 * session, or start one if the manager is idle and can. A no-op for the Town Hall, buildings without a working manager
 * agent, and reports already offered. The manager's rollups are Town Hall items, never in `intrayOf(building)`, so a
 * manage session can't wake itself; the manager's own work reports (self-assigned or meeting-decided work, town hall
 * 2026-10-25 decision 6) are in it and wake the session like a resident's. A 1:1 that ended is announced to the session it was fed
 * into (which then ends once no 1:1 is open). While draining, a 1:1 is still answered (and started) but new reports
 * wait; the restart cuts the session, and a fresh one picks the 1:1 up after it. A resident a human opened a 1:1 with is
 * woken the same way, for its 1:1s only. Returns the started sessions' promises.
 */
export function wakeManager(ctx: Ctx, st: ManageState, gate: ManageGate, buildingId: string): Promise<Session>[] {
  const { world } = ctx;
  const building = world.buildings.get(buildingId);
  if (!building) return [];
  // the Town Hall has no manager: only its residents' 1:1s (the Planner's "Plan with an agent") are answered
  const mgr = building.kind === "town-hall" ? undefined : managerAgentOf(world, building);
  const out: Promise<Session>[] = [];
  const add = (p: Promise<Session> | null) => { if (p) out.push(p); };
  if (mgr && homeOf(world, mgr.id) === building.id) add(wakeTalker(ctx, st, gate, mgr, intrayOf(world, building.id).filter((d) => !st.offered.has(d.id))));
  // residents a human opened a 1:1 with (a report's "Talk to <author>", core/src/meetings.ts createOneOnOne): they
  // answer it the same way, in a host session of their own, with no in-tray to offer
  // (and those whose fed 1:1 just ended, so their session hears it and can end)
  const ended = [...st.fed.keys()].map((id) => world.meetings.get(id)).filter((m) => m?.buildingId === building.id);
  const others = new Set([...world.meetings.where("kind = 'one-on-one' AND buildingId = ? AND phase = 'discussing'", [building.id]), ...ended].map((m) => m!.facilitatorId));
  for (const id of others) {
    const a = id && id !== mgr?.id ? world.agents.get(id) : undefined;
    if (a && a.kind === "resident" && homeOf(world, a.id) === building.id) add(wakeTalker(ctx, st, gate, a, []));
  }
  // 1:1s whose agent has no open 1:1 left (and no live session to tell): forget them
  for (const [mid, f] of [...st.fed]) {
    const m = world.meetings.get(mid);
    if (m?.buildingId === building.id && m.phase !== "discussing" && ![...ctx.live.values()].some((l) => l.sessionId === f.sessionId)) st.fed.delete(mid);
  }
  for (const mid of [...st.busyNoticed.keys()]) if (world.meetings.get(mid)?.phase !== "discussing") st.busyNoticed.delete(mid);
  return out;
}

/** One agent's turn of `wakeManager`: feed its live manage session, or start one over `fresh` reports and its open 1:1s. */
function wakeTalker(ctx: Ctx, st: ManageState, gate: ManageGate, agent: Agent, fresh: Doc[]): Promise<Session> | null {
  const { world } = ctx;
  const nameOf = world.nameOf.bind(world);
  const talks = openOneOnOnes(world, agent.id);
  const live = ctx.live.get(agent.id);
  const feedable = !!live && live.purpose === "manage" && live.kind === "host" && !live.stopped && !live.reportSubmitted && !live.input.closed;
  // 1:1s this session was fed that have since ended: tell it, so it can still record decisions, then let it end
  for (const [mid, f] of [...st.fed]) {
    if (!live || live.sessionId !== f.sessionId) continue;
    const m = world.meetings.get(mid);
    if (m && m.phase === "discussing") continue;
    st.fed.delete(mid);
    if (m && feedable) live.input.push(oneOnOneEnded(m));
  }
  if (live) {
    // a work session (or a desk) is busy: the tick offers these once it has ended; meanwhile the human is told why it's
    // silent (Mitchell's 1:1 with Nell mt_v79lzn92wk got no answer and no word while her desk session ran)
    if (!feedable) { noticeBusy(ctx, st, agent, live.sessionId, talks); return null; }
    // while draining the session keeps answering its 1:1s (the drain waits on it only briefly, then the restart cuts it
    // and a new session resumes the 1:1 from its transcript; docs/meetings.md §6); new reports wait for the new server
    if (gate.draining() && !talks.length) return null;
    for (const d of gate.draining() ? [] : fresh) if (live.input.push(managerNewReport(d, nameOf))) st.offered.add(d.id);
    for (const m of talks) {
      const f = st.fed.get(m.id);
      if (f?.sessionId !== live.sessionId) {
        if (live.input.push(oneOnOnePrompt(m, nameOf, talkBlocks(world, m)))) st.fed.set(m.id, { sessionId: live.sessionId, idx: m.transcript.length });
        continue;
      }
      for (const u of m.transcript.slice(f.idx)) if (u.speakerId !== agent.id && u.speakerKind !== "system") live.input.push(oneOnOneUtterance(m, nameOf(u.speakerId), u.text));
      f.idx = m.transcript.length;
    }
    return null;
  }
  if (!fresh.length && !talks.length) return null;
  // a 1:1 starts even while a redeploy drains (a human is waiting; the drain doesn't hold for it), in-tray work doesn't
  if (gate.starting(agent.id) || agent.status !== "idle" || (gate.draining() && !talks.length) || !gate.slotFree() || !world.budget.canStart(agent.id)) return null;
  const offer = gate.draining() ? [] : fresh;
  for (const d of offer) st.offered.add(d.id);
  return runManageSession(ctx, st, agent.id, offer, talks);
}

/** Tell each open 1:1 (once per busy session) that its agent is in another session and answers when that ends. */
function noticeBusy(ctx: Ctx, st: ManageState, agent: Agent, sessionId: string, talks: Meeting[]): void {
  const { world } = ctx;
  for (const m of talks) {
    if (st.busyNoticed.get(m.id) === sessionId) continue;
    st.busyNoticed.set(m.id, sessionId);
    const asg = world.sessions.get(sessionId)?.assignmentId;
    const title = asg ? world.assignments.get(asg)?.title : undefined;
    meetingNotice(world, m.id, `${agent.name} is in a work session${title ? ` ("${title.length > 80 ? title.slice(0, 79) + "…" : title}")` : ""} and answers here when it ends.`);
  }
}

/** A 1:1 whose last word is the human's while its agent is busy in a work session: it waits for that session to end. */
const awaitingBusyAgent = (ctx: Ctx, m: Meeting): boolean => {
  const live = ctx.live.get(m.facilitatorId ?? "");
  const last = [...m.transcript].reverse().find((u) => u.speakerKind !== "system");
  return !!live && live.purpose !== "manage" && !!last && last.speakerId !== m.facilitatorId;
};

/** What a 1:1's prompt carries after the conversation: the human's past decisions, and the Planner's brief in a Planner 1:1. */
const talkBlocks = (world: World, m: Meeting): string => [humanDecisionsBlock(world, m), world.reorgs.plannerBrief(m)].filter(Boolean).join("\n\n");

/**
 * Close 1:1s nobody spoke in for ONE_ON_ONE_QUIET_MS (nobody typing either). The phase event wakes the manager to wrap up.
 * A 1:1 whose human line waits on an agent busy in a work session stays open; once the work ends the tick (which runs this
 * after `wakeManager`) starts the answering session, and the quiet clock restarts from that session's start.
 */
export function closeQuietOneOnOnes(ctx: Ctx): void {
  const { world } = ctx;
  const now = ctx.now().getTime();
  for (const m of world.meetings.where("kind = 'one-on-one' AND phase = 'discussing'")) {
    // quiet since the last line, or since the agent's manage session started (woken late, after a work session ended)
    const live = ctx.live.get(m.facilitatorId ?? "");
    const started = live?.purpose === "manage" ? Date.parse(world.sessions.get(live.sessionId)?.startedAt ?? "") || 0 : 0;
    const last = Math.max(Date.parse(m.transcript.at(-1)?.at ?? m.startedAt ?? m.createdAt), started);
    if (now - last < ONE_ON_ONE_QUIET_MS || humanTyping(world, m.id, now) || awaitingBusyAgent(ctx, m)) continue;
    endMeeting(world, null, m.id, `Quiet for ${ONE_ON_ONE_QUIET_MS / 60_000} minutes; closed by the town.`, { kind: "system", id: "quiet-1:1" });
  }
}

/**
 * Run one manage session (registers in `ctx.live` synchronously, before the first await): over `fresh` reports, or the
 * open 1:1s `talks` (the first is the prompt; the rest and the reports arrive as the next messages). Resolves with the
 * ended session.
 */
export async function runManageSession(ctx: Ctx, st: ManageState, agentId: string, fresh: Doc[], talks: Meeting[] = []): Promise<Session> {
  const { world } = ctx;
  const agent = world.agents.require(agentId, "agent");
  const building = world.buildings.require(homeOf(world, agentId)!, "building");
  const nameOf = world.nameOf.bind(world);
  const [first, ...more] = talks;
  const run = runAgentSession(ctx, {
    agentId, purpose: "manage", model: agent.model ?? building.model, maxTurns: building.maxTurnsPerSession, web: false, meetingId: first?.id ?? null,
    system: workSystemPrompt(agent, building, world.town.get(), { ...sessionMemory(world, agent, building), skills: skillsBlock(world.skills.forAgent(agentId)) }),
    prompt: first ? oneOnOnePrompt(first, nameOf, talkBlocks(world, first)) : managePrompt(building, fresh, nameOf),
    keepOpen: () => openOneOnOnes(world, agentId).length > 0,
  });
  // runAgentSession registered the live session before its first await: queue what the prompt didn't cover
  const live = ctx.live.get(agentId);
  if (live && first) {
    for (const m of talks) st.fed.set(m.id, { sessionId: live.sessionId, idx: m.transcript.length });
    for (const m of more) live.input.push(oneOnOnePrompt(m, nameOf, talkBlocks(world, m)));
    for (const d of fresh) live.input.push(managerNewReport(d, nameOf));
  }
  const out = await run;
  // no fallback report for this purpose: an idle building is silent; the event log says what the session did
  const s = out.session;
  const decided = world.docs.count("type = 'report' AND decidedBy = ? AND decidedAt >= ?", [agentId, s.startedAt]);
  const rollup = s.reportId ? world.docs.get(s.reportId) : undefined;
  world.events.append({
    type: "system", agentId, buildingId: building.id,
    text: `${agent.name}'s ${talks.length && managerAgentOf(world, building)?.id !== agentId ? "1:1" : "in-tray"} session ended (${s.status}): decided ${decided} report${decided === 1 ? "" : "s"}, ${rollup ? `rollup "${rollup.title}"` : "no rollup"}`,
    payload: { sessionId: s.id, purpose: "manage", decided, rollupId: rollup?.id ?? null },
  });
  return s;
}
