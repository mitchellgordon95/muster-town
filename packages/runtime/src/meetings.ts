/** Meetings: summaries while collecting (cheapModel, no tools), then a facilitated discussion over MCP. */
import { TOWN_HALL_ID } from "@agent-town/core";
import type { Meeting } from "@agent-town/schema";
import { facilitatePrompt, facilitateSystemPrompt, summaryPrompt, summarySystemPrompt } from "@agent-town/core";
import { oneShot } from "./sdk.ts";
import { chargeUsage, fundingFor, homeOf, runAgentSession, type Ctx } from "./session.ts";
import { latestReport } from "./work.ts";

export const COLLECTING_MS = 3 * 60_000;
// room for a long back-and-forth with a human: each listen waits up to 60 s
const FACILITATE_MAX_TURNS = 60;

export interface MeetingState {
  /** meetingId → when collecting began (ms) */
  collectingSince: Map<string, number>;
  summarized: Set<string>;
  facilitated: Set<string>;
}

export function newMeetingState(): MeetingState {
  return { collectingSince: new Map(), summarized: new Set(), facilitated: new Set() };
}

const meetingRoom = (m: Meeting) => `meeting-room:${m.buildingId ?? TOWN_HALL_ID}`;

/** One attendee's summary: a cheap one-shot call, recorded through the `meeting` verb. */
async function summarize(ctx: Ctx, m: Meeting, agentId: string): Promise<void> {
  const { world } = ctx;
  const agent = world.agents.get(agentId);
  if (!agent || agent.kind === "human" || m.summaries[agentId] || !world.budget.canStart(agentId)) return;
  const bid = homeOf(world, agentId);
  const building = bid ? world.buildings.get(bid) : undefined;
  const model = building?.cheapModel ?? "claude-haiku-5-5";
  const funding = fundingFor(world, agentId);
  const session = world.ops.startSession(agentId, { purpose: "summary", model, meetingId: m.id });
  const events = world.events.recent({ agentId, limit: 20 });
  const out = await oneShot(ctx.sdk, { model, system: summarySystemPrompt(agent), prompt: summaryPrompt(m, latestReport(ctx, agentId), events), apiKey: funding.apiKey });
  const text = out.text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join("\n");
  let error = out.error;
  if (text) {
    try { await world.verbs.meeting(agentId, { meetingId: m.id, action: "summary", text }); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
  } else error ??= "empty summary";
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
      if (a && a.kind !== "human" && a.status !== "working" && !world.movement.isWalking(id)) world.movement.go(a, room.pos, room.name).catch(() => undefined);
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
        system: facilitateSystemPrompt(fac, bid, world.town.get()), prompt: facilitatePrompt(m, (id) => world.nameOf(id)),
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
  // a body still walking to the room would otherwise restore `in-meeting` after the meeting ended
  for (const id of new Set([...m.attendeeIds, ...(m.facilitatorId ? [m.facilitatorId] : [])])) {
    if (world.movement.isWalking(id)) world.movement.cancel(id, "Meeting ended.");
    const a = world.agents.get(id);
    if (a?.status === "in-meeting" && !a.currentMeetingId) world.setStatus(id, "idle");
  }
}
