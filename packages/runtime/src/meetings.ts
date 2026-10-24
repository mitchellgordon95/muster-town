/** Meetings: summaries while collecting (SUMMARY_MODEL, no tools), then a facilitated discussion over MCP. */
import { TOWN_HALL_ID } from "@muster-town/core";
import type { Meeting } from "@muster-town/schema";
import { recentWorkBlock } from "@muster-town/core";
import { facilitateMaterial, facilitatePrompt, facilitateSystemPrompt, lastMeetingFor, meetingReplyPrompt, meetingReplySystemPrompt, summaryPrompt, summarySystemPrompt } from "@muster-town/core";
import { oneShot } from "./sdk.ts";
import { chargeUsage, fundingFor, homeOf, runAgentSession, type Ctx } from "./session.ts";
import { latestReport } from "./work.ts";

export const COLLECTING_MS = 3 * 60_000;
// room for a long back-and-forth with a human: each listen waits up to 60 s
const FACILITATE_MAX_TURNS = 60;
/** an attendee answers at most this many @mentions per meeting (a facilitator stuck in a loop can't run up the bill) */
export const MEETING_REPLIES_MAX = 5;
const MEETING_REPLY_MAX_CHARS = 1200;
/**
 * Model for attendee summaries. Its own constant, not `building.cheapModel`: cheapModel stays Haiku for the proxy chat,
 * and changing its schema default would not reach buildings already in the DB (town hall 2026-10-24, docs/meetings.md §2).
 */
export const SUMMARY_MODEL = "claude-sonnet-5-5";

export interface MeetingState {
  /** meetingId → when collecting began (ms) */
  collectingSince: Map<string, number>;
  summarized: Set<string>;
  facilitated: Set<string>;
  /** `${meetingId}:${agentId}` → replies spoken / in flight / mentioned again while in flight */
  replies: Map<string, number>;
  replying: Set<string>;
  mentionedAgain: Set<string>;
}

export function newMeetingState(): MeetingState {
  return { collectingSince: new Map(), summarized: new Set(), facilitated: new Set(), replies: new Map(), replying: new Set(), mentionedAgain: new Set() };
}

const meetingRoom = (m: Meeting) => `meeting-room:${m.buildingId ?? TOWN_HALL_ID}`;

/** One attendee's summary: a one-shot call on SUMMARY_MODEL, recorded through the `meeting` verb. */
async function summarize(ctx: Ctx, m: Meeting, agentId: string): Promise<void> {
  const { world } = ctx;
  const agent = world.agents.get(agentId);
  if (!agent || agent.kind === "human" || m.summaries[agentId] || !world.budget.canStart(agentId)) return;
  const model = SUMMARY_MODEL;
  const funding = fundingFor(world, agentId);
  const session = world.ops.startSession(agentId, { purpose: "summary", model, meetingId: m.id });
  const events = world.events.recent({ agentId, limit: 20 });
  const out = await oneShot(ctx.sdk, { model, system: summarySystemPrompt(agent), prompt: summaryPrompt(m, latestReport(ctx, agentId), events, recentWorkBlock(world, agentId, { short: true, readHint: false }), lastMeetingFor(world, m, agentId)), apiKey: funding.apiKey });
  const text = out.text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join("\n");
  let error = out.error;
  if (text && !error) { // a failed call's text is its error message ("Not logged in"), not a summary
    try { await world.verbs.meeting(agentId, { meetingId: m.id, action: "summary", text }); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
  } else error ??= "empty summary";
  world.ops.endSession(session.id, { status: error ? "error" : "done", tokens: out.tokens, costUsd: out.costUsd, turns: out.turns, error });
  chargeUsage(world, agentId, out, funding.allocationId);
}

const LIVE = new Set(["collecting", "discussing"]);

/**
 * An @mention in a live meeting by its facilitator or a human: the mentioned attendee gets one short turn (no tools;
 * transcript plus its assignment, latest report and recent activity) and speaks its reply into the meeting.
 * Mentions by other attendees don't wake anyone, so replies can't chain. A mention while a reply is in flight
 * gets one more turn after it, up to MEETING_REPLIES_MAX per attendee per meeting.
 */
export async function onMeetingMention(ctx: Ctx, st: MeetingState, meetingId: string, agentId: string, byId: string, byKind: string): Promise<void> {
  const { world } = ctx;
  const m = world.meetings.get(meetingId);
  const agent = world.agents.get(agentId);
  if (!m || !LIVE.has(m.phase) || !agent || !m.attendeeIds.includes(agentId) || agentId === m.facilitatorId) return;
  if (agent.kind !== "resident" && agent.kind !== "visitor") return;
  if (agent.status === "banned" || agent.status === "retired") return;
  if (byKind !== "user" && byId !== m.facilitatorId) return;
  const key = `${meetingId}:${agentId}`;
  if (st.replying.has(key)) { st.mentionedAgain.add(key); return; }
  st.replying.add(key);
  try {
    do {
      st.mentionedAgain.delete(key);
      if ((st.replies.get(key) ?? 0) >= MEETING_REPLIES_MAX || !world.budget.canStart(agentId)) return;
      st.replies.set(key, (st.replies.get(key) ?? 0) + 1);
      await replyInMeeting(ctx, meetingId, agentId);
    } while (st.mentionedAgain.has(key));
  } finally {
    st.replying.delete(key);
    st.mentionedAgain.delete(key);
  }
}

async function replyInMeeting(ctx: Ctx, meetingId: string, agentId: string): Promise<void> {
  const { world } = ctx;
  const m = world.meetings.get(meetingId);
  const agent = world.agents.get(agentId);
  if (!m || !LIVE.has(m.phase) || !agent) return;
  const home = homeOf(world, agentId);
  const model = agent.model ?? (home ? world.buildings.get(home)?.model : undefined) ?? "claude-opus-5-5";
  const funding = fundingFor(world, agentId);
  const session = world.ops.startSession(agentId, { purpose: "meeting-reply", model, meetingId });
  const assignment = agent.currentAssignmentId ? world.assignments.get(agent.currentAssignmentId) : undefined;
  const prompt = meetingReplyPrompt(m, (id) => world.nameOf(id), { assignment, lastReport: latestReport(ctx, agentId), events: world.events.recent({ agentId, limit: 20 }), recentWork: recentWorkBlock(world, agentId, { short: true, readHint: false }) });
  const out = await oneShot(ctx.sdk, { model, system: meetingReplySystemPrompt(agent), prompt, apiKey: funding.apiKey });
  const text = out.text.trim().slice(0, MEETING_REPLY_MAX_CHARS);
  let error = out.error;
  if (text) {
    try { await world.verbs.meeting(agentId, { meetingId, action: "speak", text }); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
  } else error ??= "empty reply";
  world.ops.endSession(session.id, { status: error ? "error" : "done", tokens: out.tokens, costUsd: out.costUsd, turns: out.turns, error });
  chargeUsage(world, agentId, out, funding.allocationId);
}

/**
 * A meeting entered `collecting` (or was created with startNow). Moves `scheduled` → `collecting`,
 * then every attendee writes a summary. Idempotent per meeting.
 */
export async function onMeetingStart(ctx: Ctx, st: MeetingState, meetingId: string): Promise<void> {
  const { world } = ctx;
  let m = world.meetings.require(meetingId, "meeting");
  if (m.phase === "scheduled") m = world.ops.setMeetingPhase(m.id, "collecting");
  if (m.phase !== "collecting" || st.summarized.has(m.id)) return;
  st.summarized.add(m.id);
  if (!st.collectingSince.has(m.id)) st.collectingSince.set(m.id, ctx.now().getTime());
  await Promise.all(m.attendeeIds.map((id) => summarize(ctx, m, id).catch((e) => console.log("[runtime] summary failed:", e))));
}

/** Move collecting meetings to discussing after COLLECTING_MS. */
export function advanceCollecting(ctx: Ctx, st: MeetingState): void {
  const now = ctx.now().getTime();
  for (const m of ctx.world.meetings.where("phase = 'collecting'")) {
    const since = st.collectingSince.get(m.id) ?? Date.parse(m.scheduledAt);
    if (!st.collectingSince.has(m.id)) st.collectingSince.set(m.id, since);
    if (now - since >= COLLECTING_MS) ctx.world.ops.setMeetingPhase(m.id, "discussing");
  }
}

/** Discussion: bodies walk to the meeting room; the facilitator runs a session with the `meeting` verb; the runtime ends the meeting if they didn't. */
export async function facilitate(ctx: Ctx, st: MeetingState, meetingId: string): Promise<void> {
  const { world } = ctx;
  const m = world.meetings.get(meetingId);
  if (!m || m.phase !== "discussing" || st.facilitated.has(m.id)) return;
  st.facilitated.add(m.id);
  const room = world.layout.place(meetingRoom(m));
  if (room) {
    for (const id of new Set([...m.attendeeIds, ...(m.facilitatorId ? [m.facilitatorId] : [])])) {
      const a = world.agents.get(id);
      if (a && a.kind !== "human" && a.status !== "working" && !world.movement.isWalking(id)) world.movement.go(a, world.standingTile(room.id, a.id) ?? room.pos, room.name).catch(() => undefined);
    }
  }
  const fac = m.facilitatorId ? world.agents.get(m.facilitatorId) : undefined;
  if (fac && fac.status !== "banned" && fac.status !== "stopped" && world.budget.canStart(fac.id)) {
    const bid = m.buildingId ? world.buildings.get(m.buildingId) : undefined;
    const home = homeOf(world, fac.id);
    const model = fac.model ?? bid?.model ?? (home ? world.buildings.get(home)?.model : undefined) ?? "claude-opus-5-5";
    try {
      await runAgentSession(ctx, {
        agentId: fac.id, purpose: "facilitate", model, maxTurns: FACILITATE_MAX_TURNS, web: false, meetingId: m.id,
        system: facilitateSystemPrompt(fac, bid, world.town.get()), prompt: facilitatePrompt(m, (id) => world.nameOf(id), facilitateMaterial(world, m)),
      });
    } catch (e) {
      console.log("[runtime] facilitation failed:", e);
    }
  }
  const after = world.meetings.get(m.id);
  if (after && after.phase !== "done" && after.phase !== "cancelled") {
    world.ops.endMeeting(null, m.id, fac ? `${fac.name} didn't close the meeting; closed by the town.` : "No facilitator; closed by the town.");
  }
  st.collectingSince.delete(m.id);
  for (const k of [...st.replies.keys()]) if (k.startsWith(`${m.id}:`)) st.replies.delete(k);
  // a body still walking to the room would otherwise restore `in-meeting` after the meeting ended
  for (const id of new Set([...m.attendeeIds, ...(m.facilitatorId ? [m.facilitatorId] : [])])) {
    if (world.movement.isWalking(id)) world.movement.cancel(id, "Meeting ended.");
    const a = world.agents.get(id);
    if (a?.status === "in-meeting" && !a.currentMeetingId) world.setStatus(id, "idle");
  }
}
