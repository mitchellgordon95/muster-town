import { CreateMeetingInput, Meeting, type Agent } from "@muster-town/schema";
import { applyDecision, createAssignment, createDoc, sendMessage, setAssignmentStatus, updateDoc } from "./domain.ts";
import { AppError, badRequest, forbidden, notFound } from "./errors.ts";
import { buildingRoleId, townRoleId } from "./permissions.ts";
import { notifyMentions } from "./mentions.ts";
import { oneLine } from "./text.ts";
import { newId, nowIso } from "./util.ts";
import { validateWait } from "./waits.ts";
import { TOWN_HALL_ID } from "./world/layout.ts";
import type { World } from "./world.ts";

type CreateMeeting = (typeof CreateMeetingInput)["_input"];

/**
 * Residents of a building, stopped ones included (a standup is where they get reactivated with a new task); for
 * town-hall meetings, agents holding manager/reviewer anywhere plus town moderators.
 */
export function defaultAttendees(world: World, buildingId: string | null): string[] {
  if (buildingId && buildingId !== TOWN_HALL_ID) {
    return world.agents.where("homeBuildingId = ? AND kind = 'resident' AND status NOT IN ('banned','retired')", [buildingId], "ORDER BY createdAt").map((a) => a.id);
  }
  const ids = new Set<string>();
  for (const b of world.buildings.where("kind = 'lab'")) {
    for (const r of ["manager", "reviewer"] as const) for (const id of world.permissions.agentsWithRole(buildingRoleId(b.id, r))) ids.add(id);
  }
  for (const id of world.permissions.agentsWithRole(townRoleId("moderator"))) ids.add(id);
  return [...ids].filter((id) => { const s = world.agents.get(id)?.status; return !!s && s !== "banned" && s !== "retired"; });
}

/**
 * The building's manager (set explicitly in its settings), else its reviewer agent, else the first resident by join
 * order. Town hall: the first active manager among the invitees (buildings in creation order), else the first active
 * invitee (docs/meetings.md §3.4). Never the first *invitee* by default: the UI's picker sends invitees sorted by
 * name, which made the facilitator whoever sorted first.
 */
export function defaultFacilitator(world: World, buildingId: string | null, attendees: string[]): string | null {
  const active = (id: string | null | undefined): id is string => { const s = id ? world.agents.get(id)?.status : undefined; return !!s && s !== "stopped" && s !== "banned" && s !== "retired"; };
  if (buildingId && buildingId !== TOWN_HALL_ID) {
    const manager = world.buildings.get(buildingId)?.managerAgentId;
    if (active(manager)) return manager;
    const rev = world.permissions.agentsWithRole(buildingRoleId(buildingId, "reviewer")).find(active);
    if (rev) return rev;
    const first = defaultAttendees(world, buildingId).find((id) => active(id) && attendees.includes(id));
    if (first) return first;
  } else {
    for (const b of world.buildings.where("kind = 'lab'", [], "ORDER BY createdAt, rowid")) {
      if (active(b.managerAgentId) && attendees.includes(b.managerAgentId)) return b.managerAgentId;
    }
  }
  return attendees.find(active) ?? attendees[0] ?? null;
}

/** The previous `done` meeting of the same scope (same building, or the previous town hall), by end time. */
export function previousMeeting(world: World, m: Pick<Meeting, "id" | "buildingId">): Meeting | undefined {
  return m.buildingId
    ? world.meetings.first("phase = 'done' AND buildingId = ? AND id != ?", [m.buildingId, m.id], "ORDER BY endedAt DESC, rowid DESC")
    : world.meetings.first("phase = 'done' AND buildingId IS NULL AND id != ?", [m.id], "ORDER BY endedAt DESC, rowid DESC");
}

export interface DecisionOutcome { n: number; text: string; assigneeId: string | null; outcome: string }

/**
 * A meeting's decisions (superseded ones dropped; `agentId` keeps only those assigned to that agent) with what became
 * of each: `done: "<report title>" (verdict …, decision …)`, `active`, `pending`, `cancelled`, or `no assignment`.
 * Read back from `decisions[].assignmentId`, which nothing read until the 2026-10-24 town hall (docs/meetings.md §3.1).
 */
export function decisionOutcomes(world: World, m: Meeting, agentId?: string): DecisionOutcome[] {
  const out: DecisionOutcome[] = [];
  m.decisions.forEach((d, i) => {
    if (d.supersededBy || (agentId && d.assigneeId !== agentId)) return;
    const a = d.assignmentId ? world.assignments.get(d.assignmentId) : undefined;
    const report = a?.reportId ? world.docs.get(a.reportId) : undefined;
    const outcome = !a ? "no assignment" : a.status !== "done" ? a.status : `done${report ? `: "${oneLine(report.title, 100)}" (verdict ${report.verdict ?? "?"}, decision ${report.decision ?? "pending"})` : ""}`;
    out.push({ n: i + 1, text: d.text, assigneeId: d.assigneeId ?? null, outcome });
  });
  return out;
}

/** Create a meeting. `actor` undefined = system (scheduler); otherwise needs meeting.facilitate or building.review. */
export function createMeeting(world: World, input: CreateMeeting, actor?: Agent): Meeting {
  const inp = CreateMeetingInput.parse(input);
  const bid = inp.buildingId && inp.buildingId !== TOWN_HALL_ID ? inp.buildingId : null;
  const b = bid ? world.buildings.require(bid, "building") : null;
  if (actor && !world.permissions.can(actor, "meeting.facilitate", bid ?? TOWN_HALL_ID) && !world.permissions.can(actor, "building.review", bid ?? TOWN_HALL_ID)) throw forbidden("meeting.facilitate");
  const attendeeIds = inp.attendeeIds ? [...new Set(inp.attendeeIds)] : defaultAttendees(world, bid);
  for (const id of inp.attendeeIds ?? []) {
    const a = world.agents.get(id);
    if (!a) throw notFound("agent", id);
    if (a.kind !== "resident" && a.kind !== "visitor") throw badRequest(`Can't invite ${a.name}: only resident and visitor agents attend meetings (${a.kind}).`);
    if (a.status === "banned" || a.status === "retired") throw badRequest(`Can't invite ${a.name}: they are ${a.status}.`);
  }
  const ts = nowIso();
  const meeting = world.meetings.upsert(Meeting.parse({
    id: newId("mt"), kind: inp.kind, buildingId: bid, title: inp.title ?? `${b?.name ?? "Town Hall"} ${inp.kind}`,
    scheduledAt: inp.scheduledAt ?? ts, phase: inp.startNow ? "collecting" : "scheduled",
    facilitatorId: defaultFacilitator(world, bid, attendeeIds), attendeeIds, agenda: inp.agenda ?? "", createdAt: ts,
  }));
  world.events.append({ type: "meeting.created", buildingId: bid, text: `Meeting called: ${meeting.title}`, payload: { meetingId: meeting.id, kind: meeting.kind, phase: meeting.phase, by: actor ? world.holderOf(actor).id : "system" } });
  for (const id of attendeeIds) sendMessage(world, { kind: "meeting", fromId: "system", fromKind: "system", toId: id, meetingId: meeting.id, body: `You're invited to "${meeting.title}" (${meeting.id}). Submit a short standup summary (what you did, what's next) with meeting action "summary"; the discussion starts once everyone's summary is in.` });
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
    if (phase === "discussing" && a.status === "idle") {
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
  if (m.phase !== "discussing") throw new AppError("conflict", m.phase === "collecting" || m.phase === "scheduled" ? "The meeting is still collecting summaries; you can speak once the discussion starts." : `Meeting is ${m.phase}; you can only speak during the discussion.`);
  if (!text.trim()) throw badRequest("Nothing to say.");
  const h = world.holderOf(actor);
  const updated = world.meetings.upsert({ ...m, transcript: [...m.transcript, { speakerId: h.id, speakerKind: h.kind, text, at: nowIso() }] });
  world.events.append({ type: "meeting.utterance", agentId: actor.kind === "human" ? null : actor.id, buildingId: m.buildingId, text: `${actor.name}: ${text.slice(0, 300)}`, payload: { meetingId: m.id, speakerId: h.id, speakerKind: h.kind } });
  notifyMentions(world, actor, text, { where: `meeting "${m.title}"`, meetingId: m.id, buildingId: m.buildingId });
  return updated;
}

/** An agent facilitator may not end a meeting while a human spoke within this window; the human ends it (or goes quiet). */
export const HUMAN_QUIET_MS = 5 * 60_000;

/** A human typing (or holding an unsent draft) pings at least this often; a ping older than this means they stopped. */
export const HUMAN_TYPING_MS = 30_000;

/** meetingId -> last typing ping from a human (in-memory; resets on restart, which only shortens a hold) */
const typing = new WeakMap<World, Map<string, number>>();

/** A human has text in the meeting's say box: hold off agent `end` until they send it or clear it. */
export function noteHumanTyping(world: World, meetingId: string, now = Date.now()): void {
  let map = typing.get(world);
  if (!map) { map = new Map(); typing.set(world, map); }
  map.set(meetingId, now);
}

export function humanTyping(world: World, meetingId: string, now = Date.now()): boolean {
  const at = typing.get(world)?.get(meetingId);
  return at !== undefined && now - at < HUMAN_TYPING_MS;
}

/** A human spoke within HUMAN_QUIET_MS, or is typing right now. */
export function humanStillTalking(world: World, m: Meeting, now = Date.now()): boolean {
  if (humanTyping(world, m.id, now)) return true;
  const last = [...m.transcript].reverse().find((u) => u.speakerKind === "user");
  return !!last && now - Date.parse(last.at) < HUMAN_QUIET_MS;
}

export function canFacilitate(world: World, actor: Agent, m: Meeting): boolean {
  return m.facilitatorId === actor.id || world.permissions.can(actor, "meeting.facilitate", m.buildingId ?? TOWN_HALL_ID);
}

/**
 * Record decisions; each with an assigneeId becomes an assignment (fromMeetingId set); a stopped assignee is resumed.
 * A decision with `supersedes: n` amends this meeting's decision n instead of adding a second assignment: for the same
 * assignee its pending (or running) assignment is rewritten in place; otherwise its pending assignment is cancelled and
 * the new assignee (if any) gets a fresh one. The old decision stays in the record, marked `supersededBy`.
 */
export function meetingDecide(world: World, actor: Agent | null, meetingId: string, decisions: Meeting["decisions"]): Meeting {
  const m = world.meetings.require(meetingId, "meeting");
  if (actor && !canFacilitate(world, actor, m)) throw forbidden("meeting.facilitate", "Only the facilitator can record decisions.");
  // A human may press End while the facilitator is still listening; give the facilitator a short grace window to
  // record what was agreed. Cancelled meetings and meetings closed longer ago stay closed.
  const late = m.phase === "done" && !!m.endedAt && Date.now() - Date.parse(m.endedAt) <= DECIDE_GRACE_MS;
  if (m.phase === "cancelled" || (m.phase === "done" && !late)) throw new AppError("conflict", `Meeting is ${m.phase}; decisions can't be added.`);
  const by = actor ? world.holderOf(actor) : { kind: "system" as const, id: "system" };
  // validate every supersedes before touching anything, so a bad batch changes nothing
  const replaced = new Set<number>();
  for (const d of decisions) {
    if (d.supersedes === undefined) continue;
    const n = d.supersedes;
    const old = m.decisions[n - 1];
    if (!old) throw badRequest(`supersedes ${n}: this meeting has no decision ${n} yet (it has ${m.decisions.length}).`);
    if (old.supersededBy || replaced.has(n)) throw new AppError("conflict", `Decision ${n} was already superseded${old.supersededBy ? ` by decision ${old.supersededBy}` : ""}; supersede the newer one.`);
    replaced.add(n);
    const prev = old.assignmentId ? world.assignments.get(old.assignmentId) : undefined;
    if (prev?.status === "active" && d.assigneeId !== prev.agentId) {
      throw new AppError("conflict", `${world.nameOf(prev.agentId)} is already working on "${prev.title}"; amend it for the same assignee, or stop them first.`);
    }
  }
  const all: Meeting["decisions"] = m.decisions.map((d) => ({ ...d }));
  const made: Meeting["decisions"] = [];
  for (const { supersededBy: _ignored, ...d } of decisions) {
    const num = all.length + 1;
    const title = d.text.split("\n")[0].slice(0, 120);
    let out: Meeting["decisions"][number] = d;
    if (d.supersedes !== undefined) {
      const old = all[d.supersedes - 1];
      old.supersededBy = num;
      const prev = old.assignmentId ? world.assignments.get(old.assignmentId) : undefined;
      if (prev && (prev.status === "pending" || prev.status === "active")) {
        if (d.assigneeId === prev.agentId) {
          world.assignments.upsert({ ...prev, title, ...(prev.status === "pending" ? { waitFor: d.waitFor ? validateWait(world, d.waitFor) : null } : {}), description: `${d.text}\n\nDecided in meeting "${m.title}" (amended; replaces: ${old.text.split("\n")[0].slice(0, 160)}).`, updatedAt: nowIso() });
          if (prev.status === "active") sendMessage(world, { kind: "system", fromId: "system", fromKind: "system", toId: prev.agentId, body: `Your current assignment was amended in meeting "${m.title}": ${d.text}` });
          out = { ...d, assignmentId: prev.id };
        } else {
          setAssignmentStatus(world, prev.id, "cancelled");
        }
      }
    }
    if (out.assigneeId && !out.assignmentId) {
      // A meeting decision that assigns an agent acknowledges (approve) its pending reports as superseded, so the
      // invariant "every report gets a decision" holds and the in-tray doesn't hold stale reports.
      for (const pending of world.docs.where("authorId = ? AND type = 'report' AND decision = 'pending'", [out.assigneeId], "ORDER BY createdAt")) {
        applyDecision(world, pending.id, "approve", `Superseded by a decision in meeting "${m.title}": ${d.text.split("\n")[0].slice(0, 160)}`, by);
      }
      const a = createAssignment(world, { agentId: out.assigneeId, title, description: `${d.text}\n\nDecided in meeting "${m.title}".`, createdBy: by, fromMeetingId: m.id, waitFor: d.waitFor ? validateWait(world, d.waitFor) : null });
      if (world.agents.get(out.assigneeId)?.status === "stopped") world.setStatus(out.assigneeId, "idle", `${world.nameOf(out.assigneeId)} was resumed by a decision in "${m.title}"`);
      out = { ...out, assignmentId: a.id };
    }
    all.push(out);
    made.push(out);
  }
  const updated = world.meetings.upsert({ ...m, decisions: all });
  world.events.append({ type: "meeting.decisions", buildingId: m.buildingId, text: `${m.title}: ${made.length} decision(s)${late ? " (recorded after close)" : ""}`, payload: { meetingId: m.id, decisions: made, late } });
  if (late && m.notesDocId) {
    // the notes were written at close; append what came in during the grace window so nothing is lost
    const notes = world.docs.get(m.notesDocId);
    if (notes) updateDoc(world, notes.id, { body: `${notes.body.trimEnd()}\n\n## Decisions recorded after close\n${made.map((d) => `- ${d.supersedes ? `(replaces decision ${d.supersedes}) ` : ""}${d.text}${d.assigneeId ? ` (→ ${world.agents.get(d.assigneeId)?.name ?? d.assigneeId})` : ""}`).join("\n")}\n` });
  }
  return updated;
}

/** How long after a meeting closes the facilitator may still record decisions. */
export const DECIDE_GRACE_MS = 5 * 60_000;

/** End: write the meeting-notes doc (filed in the building's filing cabinet, not its board; town-hall → library), phase done. */
export function endMeeting(world: World, actor: Agent | null, meetingId: string, closing?: string): Meeting {
  const m = world.meetings.require(meetingId, "meeting");
  if (actor && !canFacilitate(world, actor, m)) throw forbidden("meeting.facilitate", "Only the facilitator can end the meeting.");
  if (m.phase === "done") return m;
  if (m.phase === "cancelled") throw new AppError("conflict", "Meeting was cancelled; there is nothing to end.");
  const name = (id: string) => world.nameOf(id);
  const body = [
    `# ${m.title}`, "", `Kind: ${m.kind}. Facilitator: ${m.facilitatorId ? name(m.facilitatorId) : "none"}. Attendees: ${m.attendeeIds.map(name).join(", ") || "none"}.`,
    "", "## Agenda", "", m.agenda || "(none)",
    "", "## Summaries", "", ...(Object.entries(m.summaries).map(([id, s]) => `**${name(id)}:** ${s}`)), Object.keys(m.summaries).length ? "" : "(none)",
    "## Discussion", "", ...m.transcript.map((u) => `- **${name(u.speakerId)}:** ${u.text}`), m.transcript.length ? "" : "(none)",
    "## Decisions", "", ...m.decisions.map((d, i) => `${i + 1}. ${d.supersededBy ? `~~${d.text}~~ (superseded by ${d.supersededBy})` : d.text}${d.assigneeId ? ` → ${name(d.assigneeId)}` : ""}`), m.decisions.length ? "" : "(none)",
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
