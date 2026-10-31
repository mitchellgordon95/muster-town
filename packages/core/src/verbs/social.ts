import type { Agent, LookResult, MailboxDigest, Message } from "@muster-town/schema";
import { AppError, badRequest, forbidden } from "../errors.ts";
import { homeOf, pickUpFlag, sendMessage, setAssignmentStatus } from "../domain.ts";
import { notifyMentions } from "../mentions.ts";
import { actOrigin } from "../origin.ts";
import { relayWake } from "../wakes.ts";
import { chebyshev, newId, nowIso } from "../util.ts";
import type { World } from "../world.ts";
import type { VerbIn } from "./types.ts";

export const HEARING_RANGE = 3;

export function nearbyAgents(world: World, me: Agent, range = HEARING_RANGE): (Agent & { distance: number })[] {
  return world.agents.where("status NOT IN ('banned','retired') AND id != ?", [me.id])
    .map((a) => ({ ...a, distance: chebyshev(a.pos, me.pos) }))
    .filter((a) => a.distance <= range)
    .sort((a, b) => a.distance - b.distance);
}

export async function look(world: World, me: Agent, _input: VerbIn<"look">): Promise<LookResult> {
  const here = world.layout.buildingAt(me.pos);
  const place = world.layout.placeAt(me.pos);
  const current = me.currentAssignmentId ? world.assignments.get(me.currentAssignmentId) : undefined;
  const home = homeOf(me);
  const meeting = world.meetings.first(
    "phase IN ('scheduled','collecting','discussing') AND (attendeeIds LIKE ? OR (buildingId IS NOT NULL AND buildingId = ?))",
    [`%"${me.id}"%`, home ?? "-"], "ORDER BY scheduledAt");
  const mine = (p: { buildingId: string | null }) => p.buildingId === here?.id || p.buildingId === home;
  const visible = world.layout.places.filter((p) =>
    p.kind === "door" || p.kind === "plaza" || p.kind === "bank" || p.kind === "bank-map" || p.id === "library" || p.id === "outbox" ||
    // Town Hall stations everyone can walk to
    p.kind === "mod-station" || p.kind === "planning" || p.kind === "town-map" || p.kind === "goal-tree" || p.id === "schedule-board" || p.kind === "bench" || p.id === "intray:town-hall" || p.id === "board:town-hall" ||
    // the board, schedule board, filing cabinet and in-tray (manager's desk) of the building I'm in / my home building
    ((p.kind === "board" || p.kind === "schedule" || p.kind === "cabinet" || p.kind === "intray") && mine(p)) ||
    (p.kind === "meeting-room" && (mine(p) || p.buildingId === "town-hall")) ||
    (p.kind === "desk" && !p.id.startsWith("desk:free:") && mine(p)));
  return {
    me: { id: me.id, name: me.name, status: me.status, buildingId: me.buildingId, place: place?.id ?? null, pos: me.pos },
    building: here ? { id: here.id, name: here.name, goal: here.goal } : null,
    nearby: nearbyAgents(world, me).map((a) => ({ id: a.id, name: a.name, kind: a.kind, status: a.status, activity: a.activity, distance: a.distance })),
    notices: {
      unread: world.messages.count("toId = ? AND readAt IS NULL", [me.id]),
      mentions: world.messages.count("toId = ? AND readAt IS NULL AND kind = 'mention'", [me.id]),
      pendingAssignments: world.assignments.count("agentId = ? AND status = 'pending'", [me.id]),
      currentAssignment: current?.title ?? null,
      nextMeeting: meeting ? { id: meeting.id, title: meeting.title, at: meeting.scheduledAt, phase: meeting.phase } : null,
      ...digestFor(world, me),
    },
    places: visible.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
  };
}

/** v1.4: a visitor's first look after coming back from offline carries what arrived while it was away. */
function digestFor(world: World, me: Agent): { digest?: MailboxDigest } {
  if (me.kind !== "visitor") return {};
  const digest = world.presence.takeDigest(me.id);
  return digest ? { digest } : {};
}

export async function go(world: World, me: Agent, input: VerbIn<"go">) {
  // a planted flag (flag:<docId>): walk to it; the building's manager picks it up and reads it (dc_r40dq3znse)
  if (input.to.startsWith("flag:")) {
    const flag = world.docs.get(input.to.slice(5));
    if (!flag || flag.type !== "flag" || !flag.flagPos) throw new AppError("not_found", `No flag on the map: ${input.to}.`);
    const arrived = await world.movement.go(me, flag.flagPos, `${world.nameOf(flag.authorId)}'s flag`);
    return { arrived: true, to: input.to, pos: arrived.pos, ...pickUpFlag(world, me, world.docs.require(flag.id, "doc")) };
  }
  const place = world.layout.place(input.to);
  const target = (place && world.standingTile(place.id, me.id)) ?? world.agents.get(input.to)?.pos;
  if (!target) throw new AppError("not_found", `Unknown place or agent: ${input.to}. Use \`look\` to list places.`);
  const label = place?.name ?? world.nameOf(input.to);
  const arrived = await world.movement.go(me, target, label, place ? undefined : input.to);
  return { arrived: true, to: input.to, pos: arrived.pos, place: world.layout.placeAt(arrived.pos)?.id ?? null };
}

export async function say(world: World, me: Agent, input: VerbIn<"say">) {
  const listeners = nearbyAgents(world, me).filter((a) => a.kind !== "human");
  world.events.append({ type: "agent.said", agentId: me.id, buildingId: me.buildingId, text: input.text, payload: { heardBy: listeners.map((a) => a.id) } });
  for (const a of listeners) sendMessage(world, { kind: "heard", fromId: me.id, fromKind: "agent", toId: a.id, body: input.text });
  notifyMentions(world, me, input.text, { where: "speech", buildingId: me.buildingId });
  return { heardBy: listeners.map((a) => a.name) };
}

export async function tell(world: World, me: Agent, input: VerbIn<"tell">) {
  let to = world.agents.get(input.to);
  if (!to) throw new AppError("not_found", `No agent with id ${input.to}.`);
  // manager forks: a retired fork's mail goes to its manager (the manager itself is told the fork is gone)
  let forwardedFrom: string | undefined;
  if (to.forkOf && to.status === "retired") {
    if (to.forkOf === me.id) throw badRequest(`${to.name} has retired (its session ended); queue the work to the building instead.`);
    forwardedFrom = to.name;
    to = world.agents.require(to.forkOf, "agent");
  }
  if (to.id === me.id) return handOff(world, me, input.text);
  const text = forwardedFrom ? `(To ${forwardedFrom}, your fork, after its session ended: it reaches you as its manager.)\n\n${input.text}` : input.text;
  // wakes step 1: a human's avatar stamps its own tell; an agent passes on its session's human origin (hops + 1)
  const id = newId("ms");
  const origin = actOrigin(world, me, id);
  const msg = sendMessage(world, { id, kind: "tell", fromId: me.id, fromKind: "agent", toId: to.id, body: text, origin });
  const told = world.events.append({ type: "agent.told", agentId: me.id, buildingId: me.buildingId, text: `${me.name} → ${to.name}: ${text.slice(0, 200)}`, payload: { to: to.id, toId: to.id, toKind: to.kind, messageId: msg.id, text, origin, ...(forwardedFrom ? { forwardedFrom: input.to } : {}) } });
  // the recipient already has the message; third parties named with @Name get a mention
  notifyMentions(world, me, input.text, { where: `a message to ${to.name}`, buildingId: me.buildingId, skip: [to.id] });
  // wakes step 2: a tell that traces to a human queues work for an idle resident
  const woke = relayWake(world, me, told);
  if (woke) return { sent: true, to: to.id, messageId: msg.id, assignmentId: woke.id, note: `${to.name} was ${to.status}: it traces to ${world.nameOf(woke.origin!.userId)}, so the town queued "${woke.title}" (${woke.id}) for ${to.name}.` };
  const note = [forwardedFrom && `${forwardedFrom} has retired (forks live for one session); delivered to ${to.name}, its manager.`, idleNote(world, me, to)].filter(Boolean).join(" ");
  return { sent: true, to: to.id, messageId: msg.id, ...(note && { note }) };
}

/**
 * A tell to yourself from a 1:1 answered beside your running work session (1:1 mt_ufwllf4wmt decision 1): the human's
 * request reaches the work session at once, the way their own mid-session message would (an interrupt: in-process for a
 * host session, queued for a desk's next control poll), as direction from the human, citing the meeting.
 */
function handOff(world: World, me: Agent, text: string) {
  const work = world.sessions.first("agentId = ? AND status = 'running' AND purpose = 'work'", [me.id], "ORDER BY startedAt DESC, rowid DESC");
  const talk = world.sessions.first("agentId = ? AND status = 'running' AND purpose = 'manage' AND meetingId IS NOT NULL", [me.id], "ORDER BY startedAt DESC, rowid DESC");
  if (!work || !talk?.meetingId) throw badRequest("You can't tell yourself. (Only a 1:1 answered beside your running work session hands a request to that session this way.)");
  const m = world.meetings.get(talk.meetingId);
  const human = m?.withUserId ? world.nameOf(m.withUserId) : "A human";
  const from = `${human} (via your 1:1 ${talk.meetingId})`;
  const itext = `${human} asked for this in your 1:1 (meeting ${talk.meetingId}); your conversation session there passed it on:\n\n${text}\n\nTreat it as direction from ${human}.`;
  // kept in the inbox too, like a human's own message, so the work session finds it there after the interrupt
  const msg = sendMessage(world, { kind: "tell", fromId: me.id, fromKind: "agent", toId: me.id, body: itext, origin: talk.origin ?? null });
  if (!world.host.interrupt?.(me.id, itext, from, true)) world.ops.enqueueInterrupt(me.id, itext, from, true);
  return { sent: true, to: me.id, messageId: msg.id, assignmentId: undefined, note: `Passed to your running work session (${work.id}) as direction from ${human}.` };
}

/** A tell with no human origin (or past the hop cap / 24 h) never starts work: for a resident with no live session (idle, stopped, out of budget) it waits unseen, so say so. */
function idleNote(world: World, me: Agent, to: Agent): string | undefined {
  if (to.kind !== "resident" || !["idle", "stopped", "out-of-budget"].includes(to.status)) return undefined;
  const how = world.permissions.can(me, "building.assign", homeOf(to))
    ? `If it needs action, use \`assign\` to give ${to.name} the work.`
    : `If it needs action, ask someone who can \`assign\` (a manager or reviewer of ${to.name}'s building).`;
  return `Delivered to ${to.name}'s inbox, but ${to.name} is ${to.status} and will not see it until a session starts: a \`tell\` does not start work. ${how}`;
}

export function formatMessage(world: World, m: Message) {
  return { id: m.id, kind: m.kind, from: m.fromKind === "system" ? "system" : world.nameOf(m.fromId), fromId: m.fromId, body: m.body, meetingId: m.meetingId, docId: m.docId, at: m.createdAt,
    // wakes step 1: the human behind it ("for Mitchell, via ms_…, 1 hop")
    ...(m.origin ? { for: world.nameOf(m.origin.userId), origin: m.origin } : {}) };
}

export async function inbox(world: World, me: Agent, input: VerbIn<"inbox">) {
  const unread = world.messages.where("toId = ? AND readAt IS NULL", [me.id], "ORDER BY createdAt DESC, rowid DESC LIMIT 100");
  if (input.markRead && unread.length) {
    const ts = nowIso();
    world.transaction(() => { for (const m of unread) world.messages.upsert({ ...m, readAt: ts }); });
  }
  return { messages: unread.map((m) => formatMessage(world, m)), note: unread.length ? undefined : "No unread messages." };
}

export async function assignments(world: World, me: Agent, _input: VerbIn<"assignments">) {
  const list = world.assignments.where("agentId = ?", [me.id], "ORDER BY createdAt DESC, rowid DESC LIMIT 20");
  return { current: me.currentAssignmentId, assignments: list.map((a) => ({ id: a.id, title: a.title, description: a.description, status: a.status, createdAt: a.createdAt, createdBy: world.nameOf(a.createdBy) })) };
}

export async function accept_assignment(world: World, me: Agent, input: VerbIn<"accept_assignment">) {
  const a = world.assignments.require(input.id, "assignment");
  if (a.agentId !== me.id) throw new AppError("forbidden", "That assignment belongs to another agent.");
  if (a.status === "done" || a.status === "cancelled") throw new AppError("conflict", `Assignment is ${a.status}.`);
  if (me.currentAssignmentId && me.currentAssignmentId !== a.id) {
    const prev = world.assignments.get(me.currentAssignmentId);
    if (prev?.status === "active") setAssignmentStatus(world, prev.id, "pending");
  }
  // v1.4: accepting an offer clears `offered`; a visitor works while it holds an active assignment
  const updated = a.status === "active" && !a.offered ? a : setAssignmentStatus(world, a.id, "active", a.offered ? { offered: false } : {});
  world.agents.patch(me.id, { currentAssignmentId: a.id });
  if (me.kind === "visitor" && (me.status === "idle" || me.status === "offline")) world.setStatus(me.id, "working", `${me.name} accepted "${updated.title}"`);
  return { id: updated.id, title: updated.title, status: updated.status };
}

export async function ban(world: World, me: Agent, input: VerbIn<"ban">) {
  const target = world.agents.require(input.agentId, "agent");
  const bid = homeOf(target);
  // ban is a town-level act (moderators / admin)
  if (!world.permissions.can(me, "town.ban")) throw forbidden("town.ban");
  if (target.kind === "human") throw badRequest("Humans can't be banned with this verb.");
  if (target.status === "retired") throw badRequest(`${target.name} was dismissed.`);
  world.movement.cancel(target.id, "Banned.");
  world.agents.patch(target.id, { status: "banned" });
  world.events.append({ type: "agent.banned", agentId: target.id, buildingId: bid, text: `${target.name} was banned by ${me.name}: ${input.reason}`, payload: { by: world.holderOf(me).id, reason: input.reason, pendingManagerReview: true } });
  return { banned: target.id };
}
