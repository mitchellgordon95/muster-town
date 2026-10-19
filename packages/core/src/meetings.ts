import { CreateMeetingInput, Meeting, type Agent } from "@agent-town/schema";
import { createAssignment, createDoc, sendMessage } from "./domain.ts";
import { AppError, badRequest, forbidden } from "./errors.ts";
import { buildingRoleId } from "./permissions.ts";
import { newId, nowIso } from "./util.ts";
import { TOWN_HALL_ID } from "./world/layout.ts";
import type { World } from "./world.ts";

type CreateMeeting = (typeof CreateMeetingInput)["_input"];
const LIVE = new Set(["collecting", "discussing"]);

/** Residents of a building; for town-hall meetings, agents holding manager/moderator anywhere. */
export function defaultAttendees(world: World, buildingId: string | null): string[] {
  if (buildingId && buildingId !== TOWN_HALL_ID) {
    return world.agents.where("homeBuildingId = ? AND kind = 'resident' AND status NOT IN ('stopped','banned')", [buildingId], "ORDER BY createdAt").map((a) => a.id);
  }
  const ids = new Set<string>();
  for (const b of world.buildings.where("kind = 'lab'")) {
    for (const r of ["manager", "moderator"] as const) for (const id of world.permissions.agentsWithRole(buildingRoleId(b.id, r))) ids.add(id);
  }
  return [...ids];
}

/** Building's moderator agent, else its first resident. */
export function defaultFacilitator(world: World, buildingId: string | null, attendees: string[]): string | null {
  if (buildingId && buildingId !== TOWN_HALL_ID) {
    const mod = world.permissions.agentsWithRole(buildingRoleId(buildingId, "moderator")).find((id) => world.agents.get(id));
    if (mod) return mod;
  }
  return attendees[0] ?? null;
}

/** Create a meeting. `actor` undefined = system (scheduler); otherwise needs meeting.facilitate or building.review. */
export function createMeeting(world: World, input: CreateMeeting, actor?: Agent): Meeting {
  const inp = CreateMeetingInput.parse(input);
  const bid = inp.buildingId && inp.buildingId !== TOWN_HALL_ID ? inp.buildingId : null;
  const b = bid ? world.buildings.require(bid, "building") : null;
  if (actor && !world.permissions.can(actor, "meeting.facilitate", bid ?? TOWN_HALL_ID) && !world.permissions.can(actor, "building.review", bid ?? TOWN_HALL_ID)) throw forbidden("meeting.facilitate");
  const attendeeIds = defaultAttendees(world, bid);
  const ts = nowIso();
  const meeting = world.meetings.upsert(Meeting.parse({
    id: newId("mt"), kind: inp.kind, buildingId: bid, title: inp.title ?? `${b?.name ?? "Town Hall"} ${inp.kind}`,
    scheduledAt: inp.scheduledAt ?? ts, phase: inp.startNow ? "collecting" : "scheduled",
    facilitatorId: defaultFacilitator(world, bid, attendeeIds), attendeeIds, agenda: inp.agenda ?? "", createdAt: ts,
  }));
  world.events.append({ type: "meeting.created", buildingId: bid, text: `Meeting called: ${meeting.title}`, payload: { meetingId: meeting.id, kind: meeting.kind, phase: meeting.phase, by: actor ? world.holderOf(actor).id : "system" } });
  for (const id of attendeeIds) sendMessage(world, { kind: "meeting", fromId: "system", fromKind: "system", toId: id, meetingId: meeting.id, body: `You're invited to "${meeting.title}" (${meeting.id}). Submit a three-line summary with meeting action "summary".` });
  return meeting;
}

/**
 * Move a meeting to a phase. discussing → attendees `in-meeting`; done/cancelled → attendees back to idle.
 * (Ending with notes goes through `endMeeting`.)
 */
export function setMeetingPhase(world: World, meetingId: string, phase: Meeting["phase"]): Meeting {
  const m = world.meetings.require(meetingId, "meeting");
  if (m.phase === phase) return m;
  if (m.phase === "done" || m.phase === "cancelled") throw new AppError("conflict", `Meeting is already ${m.phase}.`);
  const ts = nowIso();
  const updated = world.meetings.upsert({ ...m, phase, startedAt: phase === "discussing" ? m.startedAt ?? ts : m.startedAt, endedAt: phase === "done" || phase === "cancelled" ? ts : m.endedAt });
  for (const id of m.attendeeIds) {
    const a = world.agents.get(id);
    if (!a) continue;
    if (phase === "discussing" && (a.status === "idle" || a.status === "awaiting-review")) {
      world.agents.patch(id, { currentMeetingId: m.id });
      world.setStatus(id, "in-meeting");
    } else if ((phase === "done" || phase === "cancelled") && a.currentMeetingId === m.id) {
      world.agents.patch(id, { currentMeetingId: null });
      if (a.status === "in-meeting") world.setStatus(id, "idle");
    }
  }
  world.events.append({ type: "meeting.phase", buildingId: m.buildingId, text: `${m.title}: ${phase}`, payload: { meetingId: m.id, phase, from: m.phase } });
  return updated;
}

export function meetingSpeak(world: World, actor: Agent, meetingId: string, text: string): Meeting {
  const m = world.meetings.require(meetingId, "meeting");
  if (!LIVE.has(m.phase)) throw new AppError("conflict", `Meeting is ${m.phase}; you can speak while collecting or discussing.`);
  if (!text.trim()) throw badRequest("Nothing to say.");
  const h = world.holderOf(actor);
  const updated = world.meetings.upsert({ ...m, transcript: [...m.transcript, { speakerId: h.id, speakerKind: h.kind, text, at: nowIso() }] });
  world.events.append({ type: "meeting.utterance", agentId: actor.kind === "human" ? null : actor.id, buildingId: m.buildingId, text: `${actor.name}: ${text.slice(0, 300)}`, payload: { meetingId: m.id, speakerId: h.id, speakerKind: h.kind } });
  return updated;
}

export function canFacilitate(world: World, actor: Agent, m: Meeting): boolean {
  return m.facilitatorId === actor.id || world.permissions.can(actor, "meeting.facilitate", m.buildingId ?? TOWN_HALL_ID);
}

/** Record decisions; each with an assigneeId becomes an assignment (fromMeetingId set). */
export function meetingDecide(world: World, actor: Agent | null, meetingId: string, decisions: Meeting["decisions"]): Meeting {
  const m = world.meetings.require(meetingId, "meeting");
  if (actor && !canFacilitate(world, actor, m)) throw forbidden("meeting.facilitate", "Only the facilitator can record decisions.");
  const by = actor ? world.holderOf(actor) : { kind: "system" as const, id: "system" };
  const made = decisions.map((d) => {
    if (!d.assigneeId || d.assignmentId) return d;
    const a = createAssignment(world, { agentId: d.assigneeId, title: d.text.split("\n")[0].slice(0, 120), description: `${d.text}\n\nDecided in meeting "${m.title}".`, createdBy: by, fromMeetingId: m.id });
    return { ...d, assignmentId: a.id };
  });
  const updated = world.meetings.upsert({ ...m, decisions: [...m.decisions, ...made] });
  world.events.append({ type: "meeting.decisions", buildingId: m.buildingId, text: `${m.title}: ${made.length} decision(s)`, payload: { meetingId: m.id, decisions: made } });
  return updated;
}

/** End: write the meeting-notes doc (building board; town-hall → library), phase done. */
export function endMeeting(world: World, actor: Agent | null, meetingId: string, closing?: string): Meeting {
  const m = world.meetings.require(meetingId, "meeting");
  if (actor && !canFacilitate(world, actor, m)) throw forbidden("meeting.facilitate", "Only the facilitator can end the meeting.");
  if (m.phase === "done") return m;
  const name = (id: string) => world.nameOf(id);
  const body = [
    `# ${m.title}`, "", `Kind: ${m.kind}. Facilitator: ${m.facilitatorId ? name(m.facilitatorId) : "none"}. Attendees: ${m.attendeeIds.map(name).join(", ") || "none"}.`,
    "", "## Agenda", "", m.agenda || "(none)",
    "", "## Summaries", "", ...(Object.entries(m.summaries).map(([id, s]) => `**${name(id)}:** ${s}`)), Object.keys(m.summaries).length ? "" : "(none)",
    "## Discussion", "", ...m.transcript.map((u) => `- **${name(u.speakerId)}:** ${u.text}`), m.transcript.length ? "" : "(none)",
    "## Decisions", "", ...m.decisions.map((d) => `- ${d.text}${d.assigneeId ? ` → ${name(d.assigneeId)}` : ""}`), m.decisions.length ? "" : "(none)",
    ...(closing ? ["## Closing", "", closing] : []),
  ].join("\n");
  const authorAgent = actor ?? (m.facilitatorId ? world.agents.get(m.facilitatorId) ?? null : null);
  const author = authorAgent ? world.holderOf(authorAgent) : { kind: "user" as const, id: "system" };
  const doc = createDoc(world, {
    type: "meeting-notes", state: m.buildingId ? "building" : "library", title: `${m.title} — notes`, body,
    authorId: author.id, authorKind: author.kind, buildingId: m.buildingId ?? TOWN_HALL_ID,
  });
  world.meetings.upsert({ ...m, notesDocId: doc.id });
  return setMeetingPhase(world, m.id, "done");
}
