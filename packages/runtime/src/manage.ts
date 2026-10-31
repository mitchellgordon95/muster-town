/**
 * The manager's team-lead session (docs/waterfall.md §3.1–3.2 and §3.4, build steps 2 and 4): one host session per
 * building manager agent, woken by residents' reports landing in its in-tray or by a human opening a 1:1 with it.
 * It decides reports (`review`), assigns follow-ups (`assign`) and ends with a rollup (`submit_report rollup: true`)
 * only when one is due; otherwise it ends without a report. Reports that land and the human's 1:1 lines are streamed
 * into it, so it keeps the context of what it already decided; while a 1:1 is open it stays open between turns.
 */
import { alongsideWorkBlock, endMeeting, humanDecisionsBlock, humanTyping, intrayOf, managePrompt, managerAgentOf, managerNewReport, meetingNotice, oneOnOneEnded, oneOnOnePrompt, oneOnOneUtterance, sessionMemory, skillsBlock, workSystemPrompt, type World } from "@muster-town/core";
import type { Agent, Doc, Meeting, Session } from "@muster-town/schema";
import { VERB_NAMES, type VerbName } from "@muster-town/schema";
import { codeBlock } from "./code.ts";
import { claudeDirOf, findSdkTranscript, homeOf, runAgentSession, type Ctx, type LiveSession } from "./session.ts";

/** A 1:1 beside a work session can do anything a manage session can except what belongs to the work: its report and assignment. */
const ALONGSIDE_VERBS: VerbName[] = VERB_NAMES.filter((v) => v !== "submit_report" && v !== "accept_assignment");

interface ManageState {
  /** report ids already offered to a manage session (in-memory: a restart offers the in-tray again, once) */
  offered: Set<string>;
  /** 1:1 meetingId → the manage session it's fed into and how much of its transcript that session has seen */
  fed: Map<string, { sessionId: string; idx: number }>;
  /** 1:1 meetingId → the busy session already announced in it (one "busy" notice per 1:1 per session) */
  busyNoticed: Map<string, string>;
  /** manage sessions given in-tray reports (team-lead work): a 1:1 fed into one cuts its current turn short (interrupt now) */
  leading: Set<string>;
}
export const newManageState = (): ManageState => ({ offered: new Set(), fed: new Map(), busyNoticed: new Map(), leading: new Set() });

/** A 1:1 nobody spoke in for this long (and nobody is typing in) is closed by the town. */
const ONE_ON_ONE_QUIET_MS = 20 * 60_000;

/** The manager's open 1:1s. */
export const openOneOnOnes = (world: World, managerId: string): Meeting[] =>
  world.meetings.where("kind = 'one-on-one' AND facilitatorId = ? AND phase = 'discussing'", [managerId], "ORDER BY createdAt");

/** A team-lead session cut by a restart this long ago or less is resumed; an older one's in-tray is offered afresh. */
export const RESUME_WINDOW_MS = 2 * 60 * 60_000;

/** A team-lead session a restart cut, to resume: its row and the SDK session to continue. */
interface ResumableManage { sessionId: string; sdkSessionId: string }

/**
 * The manager's team-lead session to resume (gr_w9ue1k1p0c): its latest manage session, if a restart cut it (status
 * `interrupted`, error "cut by restart" or "cut by redeploy…") within RESUME_WINDOW_MS, it had no 1:1 (a 1:1 resumes from
 * its own transcript, docs/meetings.md §6), and its SDK session's JSONL is still under the claude dir. Else null: a fresh
 * session works the in-tray as before. Once the resumed session starts it is the latest, so a cut session resumes once.
 */
export function resumableManage(world: World, agentId: string, claudeDir: string, now: Date): ResumableManage | null {
  const last = world.sessions.first("agentId = ? AND purpose = 'manage'", [agentId], "ORDER BY startedAt DESC, rowid DESC");
  if (!last || last.status !== "interrupted" || !/^cut by re(start|deploy)/.test(last.error ?? "") || !last.sdkSessionId || last.meetingId) return null;
  if (!last.endedAt || now.getTime() - Date.parse(last.endedAt) > RESUME_WINDOW_MS) return null;
  if (!findSdkTranscript(claudeDir, last.sdkSessionId)) return null;
  return { sessionId: last.id, sdkSessionId: last.sdkSessionId };
}

/** The first message of a resumed team-lead session. */
export const resumePrompt = (cut: ResumableManage): string =>
  `The server restarted (a redeploy) and cut this team-lead session (${cut.sessionId}); it resumes here. Check whether the step you were on when it was cut finished (e.g. \`read\` the report to see if your decision landed) and redo it if not, then carry on with your in-tray where you left off. End as before: a rollup only if one is due, else just stop.`;

interface ManageGate {
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
  // the Town Hall's manager (the Planner) has no in-tray to work: only its 1:1s ("Plan with an agent") are answered, below
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

/**
 * One agent's turn of `wakeManager`: feed its live conversation, or start one over `fresh` reports and its open 1:1s.
 * The conversation is its manage session, or, while a work session (host or desk) is live, a 1:1-only session alongside
 * it in `ctx.talking` (1:1 mt_ufwllf4wmt decision 1): a human gets an answer while the work keeps going.
 */
function wakeTalker(ctx: Ctx, st: ManageState, gate: ManageGate, agent: Agent, fresh: Doc[]): Promise<Session> | null {
  const { world } = ctx;
  const nameOf = world.nameOf.bind(world);
  const talks = openOneOnOnes(world, agent.id);
  const live = ctx.live.get(agent.id);
  const side = ctx.talking.get(agent.id);
  // the session this agent's conversation goes into: the one alongside its work, else its own manage session
  const talker = side ?? (live?.purpose === "manage" && live.kind === "host" ? live : undefined);
  const feedable = !!talker && !talker.stopped && !talker.reportSubmitted && !talker.input.closed;
  // 1:1s this session was fed that have since ended: tell it, so it can still record decisions, then let it end
  for (const [mid, f] of [...st.fed]) {
    if (!talker || talker.sessionId !== f.sessionId) continue;
    const m = world.meetings.get(mid);
    if (m && m.phase === "discussing") continue;
    st.fed.delete(mid);
    if (m && feedable) talker.input.push(oneOnOneEnded(m));
  }
  if (talker) {
    // a conversation that is closing ends first; the next tick starts a fresh one if a 1:1 is still open
    if (!feedable) return null;
    // while draining the session keeps answering its 1:1s (the drain waits on it only briefly, then the restart cuts it
    // and a new session resumes the 1:1 from its transcript; docs/meetings.md §6); new reports wait for the new server,
    // and for the end of a conversation held alongside work (it takes 1:1s only)
    if (gate.draining() && !talks.length) return null;
    for (const d of gate.draining() || side ? [] : fresh) if (talker.input.push(managerNewReport(d, nameOf))) { st.offered.add(d.id); st.leading.add(talker.sessionId); }
    // its team-lead session is mid-turn deciding reports: the human's 1:1 cuts that turn short and is answered at once
    // (1:1 mt_q10xf3bkoq decision 2), instead of waiting for the end of a batch of tool calls; no second session
    const busy = !side && st.leading.has(talker.sessionId) && !talker.idle;
    for (const m of talks) {
      const f = st.fed.get(m.id);
      if (f?.sessionId !== talker.sessionId) {
        const prompt = oneOnOnePrompt(m, nameOf, talkBlocks(world, m, agent.id, side ? live : undefined));
        if (talker.input.push(busy ? `${oneOnOneCutIn(m)}\n\n${prompt}\n\n${RESUME_IN_TRAY}` : prompt)) {
          st.fed.set(m.id, { sessionId: talker.sessionId, idx: m.transcript.length });
          if (busy) {
            if (st.busyNoticed.get(m.id) !== talker.sessionId) { st.busyNoticed.set(m.id, talker.sessionId); meetingNotice(world, m.id, `${agent.name} is in a team-lead session; it answers between steps.`); }
            cutIn(ctx, talker, `1:1 ${m.id} opened`);
          }
        }
        continue;
      }
      let said = false;
      for (const u of m.transcript.slice(f.idx)) if (u.speakerId !== agent.id && u.speakerKind !== "system") said = talker.input.push(oneOnOneUtterance(m, nameOf(u.speakerId), u.text, u.at) + (busy ? `\n\n${RESUME_IN_TRAY}` : "")) || said;
      f.idx = m.transcript.length;
      if (said && busy) cutIn(ctx, talker, `a line in 1:1 ${m.id}`);
    }
    return null;
  }
  if (live) {
    // a work session (host or desk) is live: a human's 1:1 is answered beside it, never after it. Its reports wait.
    if (!talks.length) return null;
    if (!world.budget.canStart(agent.id)) { noticeBusy(ctx, st, agent, live.sessionId, talks); return null; }
    return runManageSession(ctx, st, agent.id, [], talks, live);
  }
  // a team-lead session a restart cut resumes (even with nothing new in the in-tray: it was mid-way through it)
  const resume = !talks.length && !gate.draining() ? resumableManage(world, agent.id, claudeDirOf(ctx), ctx.now()) : null;
  if (!fresh.length && !talks.length && !resume) return null;
  // a 1:1 starts even while a redeploy drains (a human is waiting; the drain doesn't hold for it), in-tray work doesn't
  if (gate.starting(agent.id) || agent.status !== "idle" || (gate.draining() && !talks.length) || !gate.slotFree() || !world.budget.canStart(agent.id)) return null;
  const offer = gate.draining() ? [] : fresh;
  for (const d of offer) st.offered.add(d.id);
  return runManageSession(ctx, st, agent.id, offer, talks, undefined, resume);
}

/** What a team-lead session cut short by a 1:1 is told before the 1:1's prompt. */
const oneOnOneCutIn = (m: Meeting): string =>
  `A human opened a 1:1 (${m.id}) while you were deciding reports: your current step was cut short so you answer them at once.`;
/** A team-lead session cut short by a 1:1 answers, then resumes its in-tray rather than stopping to wait. */
const RESUME_IN_TRAY = `This cut your in-tray work short. After you've spoken in the 1:1, go back to deciding your in-tray reports where you left off (check whether the step that was cut finished; redo it if not) instead of stopping to wait: the human's next line interrupts you again.`;

/** Cut the live session's current turn short (interrupt now): the message just pushed runs next. Logged like any interrupt. */
function cutIn(ctx: Ctx, l: LiveSession, why: string): void {
  const a = ctx.world.agents.get(l.agentId);
  ctx.world.events.append({ type: "system", agentId: l.agentId, buildingId: a ? a.homeBuildingId ?? a.buildingId : null, text: `Interrupt for ${a?.name ?? l.agentId}: ${why}`, payload: { sessionId: l.sessionId, interrupt: true, now: true } });
  void l.q?.interrupt?.()?.catch(() => undefined);
}

/** Tell each open 1:1 (once per busy session) that its agent is in a work session and answers when that ends (it can't start a conversation beside it: the Bank holds it). */
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

/** A 1:1 whose last word is the human's while its agent is busy in a work session with no conversation beside it: it waits for that session to end. */
const awaitingBusyAgent = (ctx: Ctx, m: Meeting): boolean => {
  if (ctx.talking.has(m.facilitatorId ?? "")) return false;
  const live = ctx.live.get(m.facilitatorId ?? "");
  const last = [...m.transcript].reverse().find((u) => u.speakerKind !== "system");
  return !!live && live.purpose !== "manage" && !!last && last.speakerId !== m.facilitatorId;
};

/**
 * What a 1:1's prompt carries after the conversation: the human's past decisions, the Planner's brief in a Planner 1:1,
 * and, beside a live work session, what that session is doing and how to hand it the human's request.
 */
const talkBlocks = (world: World, m: Meeting, agentId?: string, work?: LiveSession): string =>
  [humanDecisionsBlock(world, m), world.reorgs.plannerBrief(m), agentId && work ? alongsideWorkBlock(world, m, agentId, world.sessions.get(work.sessionId)) : ""].filter(Boolean).join("\n\n");

/**
 * Close 1:1s nobody spoke in for ONE_ON_ONE_QUIET_MS (nobody typing either). The phase event wakes the manager to wrap up.
 * A 1:1 whose human line waits on an agent busy in a work session stays open; once the work ends the tick (which runs this
 * after `wakeManager`) starts the answering session, and the quiet clock restarts from that session's start.
 */
export function closeQuietOneOnOnes(ctx: Ctx): void {
  const { world } = ctx;
  const now = ctx.now().getTime();
  for (const m of world.meetings.where("kind = 'one-on-one' AND phase = 'discussing'")) {
    // quiet since the last line, or since the agent's conversation started (woken late, after a work session ended)
    const live = ctx.talking.get(m.facilitatorId ?? "") ?? ctx.live.get(m.facilitatorId ?? "");
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
async function runManageSession(ctx: Ctx, st: ManageState, agentId: string, fresh: Doc[], talks: Meeting[] = [], work?: LiveSession, resume?: ResumableManage | null): Promise<Session> {
  const { world } = ctx;
  const agent = world.agents.require(agentId, "agent");
  const building = world.buildings.require(homeOf(world, agentId)!, "building");
  const nameOf = world.nameOf.bind(world);
  const [first, ...more] = talks;
  // the snapshot as it is now (the runtime tick keeps it within minutes of main; the session never waits on a fetch)
  const code = ctx.code?.current() ?? null;
  const run = runAgentSession(ctx, {
    agentId, purpose: "manage", model: agent.model ?? building.model, maxTurns: building.maxTurnsPerSession, web: false, meetingId: first?.id ?? null,
    // beside a work session: its own registry slot, and no verbs that act for the work (its report, its assignment)
    ...(work ? { alongside: true, verbs: ALONGSIDE_VERBS } : {}),
    system: [workSystemPrompt(agent, building, world.town.get(), { ...sessionMemory(world, agent, building), skills: skillsBlock(world.skills.forAgent(agentId)) }), code ? codeBlock(code) : ""].filter(Boolean).join("\n\n"),
    // main's code, read-only (Read, Grep, Glob): the manager reads before it answers how something works
    ...(code ? { code } : {}),
    prompt: first ? oneOnOnePrompt(first, nameOf, talkBlocks(world, first, agentId, work)) : resume ? resumePrompt(resume) : managePrompt(building, fresh, nameOf),
    keepOpen: () => openOneOnOnes(world, agentId).length > 0,
    ...(resume && !first ? { resume: resume.sdkSessionId } : {}),
  });
  // runAgentSession registered the live session before its first await: queue what the prompt didn't cover
  const live = work ? ctx.talking.get(agentId) : ctx.live.get(agentId);
  if (live && first) {
    for (const m of talks) st.fed.set(m.id, { sessionId: live.sessionId, idx: m.transcript.length });
    for (const m of more) live.input.push(oneOnOnePrompt(m, nameOf, talkBlocks(world, m, agentId, work)));
    for (const d of fresh) live.input.push(managerNewReport(d, nameOf));
  } else if (live && resume) {
    // the resumed conversation already knows its in-tray as it was; reports undecided now follow its first message
    for (const d of fresh) live.input.push(managerNewReport(d, nameOf));
    world.events.append({ type: "system", agentId, buildingId: building.id, text: `${agent.name}'s team-lead session resumes after the restart (cut session ${resume.sessionId})`, payload: { sessionId: live.sessionId, purpose: "manage", resumedFrom: resume.sessionId } });
  }
  if (live && fresh.length) st.leading.add(live.sessionId);
  const out = await run;
  if (live) st.leading.delete(live.sessionId);
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
