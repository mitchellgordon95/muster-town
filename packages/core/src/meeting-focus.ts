/**
 * The item open on a 1:1's human's screen (Mitchell, 2026-11-09: "i think the secretary should know what's open
 * please"). The Town Hall decision queue shows one item at a time beside the human's 1:1 with the Secretary; the web
 * PUTs that item as the meeting's `focus` whenever it changes and clears it when the queue closes. Every line the human
 * says in the 1:1 reaches the agent with `focusBlock` in front of it, rebuilt from live data, so "fund it" or "what's
 * this about?" has a referent; `act_in_1on1` with no target acts on it (still citing the human's words, still their
 * own gates). Only the 1:1's own human sets it; setting the same item again writes nothing. No event: it would flood.
 */
import type { Agent, Ask, Meeting, MeetingFocus } from "@muster-town/schema";
import { grantName } from "@muster-town/schema";
import { badRequest, forbidden } from "./errors.ts";
import { oneLine } from "./text.ts";
import { fromNow, stamp } from "./time.ts";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";

/** PUT /api/meetings/:id/focus: only the 1:1's human (signed in, as themselves) sets or clears it; the same item twice is a no-op. */
export function setMeetingFocus(world: World, actor: Agent, meetingId: string, focus: Pick<MeetingFocus, "kind" | "id"> | null, now = nowIso()): Meeting {
  const m = world.meetings.require(meetingId, "meeting");
  if (m.kind !== "one-on-one" || !m.withUserId) throw badRequest(`${m.id} is not a 1:1: only a 1:1 follows what its human has open.`);
  const h = world.holderOf(actor);
  if (actor.kind !== "human" || h.kind !== "user" || h.id !== m.withUserId) throw forbidden("meeting.facilitate", `Only ${world.nameOf(m.withUserId)}, whose 1:1 this is, says what is open on their screen.`);
  if (!focus) return m.focus ? world.meetings.upsert({ ...m, focus: null }) : m;
  if (m.focus?.kind === focus.kind && m.focus.id === focus.id) return m;
  if (m.phase !== "discussing") return m;
  return world.meetings.upsert({ ...m, focus: { kind: focus.kind, id: focus.id, at: now } });
}

/** A changed status said plainly, with whether it changed after the item was opened. */
const since = (at: string | null | undefined, focusAt: string) => at ? (Date.parse(at) >= Date.parse(focusAt) ? " since it was opened" : ` before it was opened (${stamp(at)})`) : "";

function askLines(world: World, a: Ask, focusAt: string): string[] {
  const out = [`Ask ${a.id} (${a.type}): "${oneLine(a.title, 160)}"`];
  if (a.body.trim()) out.push(oneLine(a.body, 700));
  if (a.branches.length) out.push(`Branches: ${a.branches.map((b) => b.label).join(" / ")}`);
  if (a.recommendation.trim()) out.push(`Recommendation: ${oneLine(a.recommendation, 240)}`);
  const status = a.status === "decided"
    ? `DECIDED${since(a.decidedAt, focusAt)}${a.decidedBy ? ` by ${world.nameOf(a.decidedBy)}` : ""}${a.decision ? `: "${oneLine(a.decision, 120)}"` : ""}. Nothing is left to decide on it.`
    : a.status === "retired" ? `RETIRED${since([...a.history].reverse().find((h) => h.action === "retire")?.at ?? a.updatedAt, focusAt)}${a.retiredBy ? ` (${oneLine(a.retiredBy, 120)})` : ""}. Nothing is left to decide on it.`
    : a.status === "folded" ? `FOLDED into ${a.foldedInto ?? "another ask"}${since(a.updatedAt, focusAt)}.`
    : a.status === "deferred" ? `deferred until ${a.deferredUntil ?? "an event"}` : "open";
  out.push(`Status: ${status}`);
  if (a.targetKind && a.targetId) out.push(`About: ${a.targetKind} ${a.targetId}${targetTitle(world, a.targetKind, a.targetId)}`);
  return out;
}

/** The title and one-line state of what an ask is about, when the town has it. */
function targetTitle(world: World, kind: string, id: string): string {
  const one = recordLine(world, kind === "request" ? "doc" : kind === "keyResult" || kind === "rule" || kind === "meeting" ? "" : kind, id);
  if (one) return ` ${one}`;
  if (kind === "keyResult") { const kr = world.keyResults.get(id); return kr ? ` "${oneLine(kr.text, 120)}"` : ""; }
  if (kind === "meeting") { const mt = world.meetings.get(id); return mt ? ` "${oneLine(mt.title, 120)}" (${mt.phase})` : ""; }
  return "";
}

/** A grant, retainer, captain or access request, goal proposal, doc or blocked building: `"<title>" (<state>)`, or null when gone. */
function recordLine(world: World, kind: string, id: string): string | null {
  switch (kind) {
    case "grant": { const g = world.grants.get(id); return g ? `"${grantName(g)}" (${g.status}; asks ${g.askTokens.toLocaleString("en-US")} tokens)` : null; }
    case "retainer": { const s = world.schedules.get(id); return s ? `"${oneLine(s.title, 120)}" (retainer ${s.retainer}${s.tokensPerRun ? `, ${s.tokensPerRun.toLocaleString("en-US")} tokens a run` : ""})` : null; }
    case "captain": { const r = world.captainRequests.get(id); const g = r ? world.goals.get(r.goalId) : undefined; return r ? `${world.nameOf(r.userId)} asks to captain "${oneLine(g?.text ?? r.goalId, 120)}" (${r.status})` : null; }
    case "access": { const r = world.accessRequests.get(id); return r ? `${world.nameOf(r.userId)} asks to join${r.message ? `: "${oneLine(r.message, 120)}"` : ""} (${r.status})` : null; }
    case "goalProposal": { const p = world.goalProposals.get(id); return p ? `${p.action} ${p.targetId ?? p.parentId ?? ""}: "${oneLine(p.fields.text ?? p.why, 120)}" by ${world.nameOf(p.proposedBy)} (${p.status})` : null; }
    case "doc": { const d = world.docs.get(id); return d ? `${d.type} "${oneLine(d.title, 120)}" by ${world.nameOf(d.authorId)} (${d.type === "request" ? `request ${d.requestStatus ?? "open"}` : d.decision ? `decided ${d.decision}` : d.state})` : null; }
    case "blocked": {
      const bid = id.replace(/^blocked:/, "");
      const b = world.grantDesk.blockedBuildings().find((x) => x.buildingId === bid);
      return b ? `${b.name} is blocked: ${oneLine(b.reason.replace(/^blocked: /, ""), 160)}` : world.buildings.get(bid) ? `${world.buildings.get(bid)!.name} (no longer blocked)` : null;
    }
    default: return null;
  }
}

const KIND_WORD: Record<MeetingFocus["kind"], string> = { ask: "ask", grant: "grant", retainer: "retainer", captain: "captain request", access: "join request", goalProposal: "goal proposal", doc: "doc", blocked: "blocked building" };

/**
 * The block in front of each of the human's 1:1 lines (and the 1:1's prompt) while something is open on their screen:
 * "" when nothing is. Rebuilt from live data each time: an ask decided or retired after it was opened says so.
 */
export function focusBlock(world: World, m: Pick<Meeting, "focus" | "withUserId">, now = Date.now()): string {
  const f = m.focus;
  if (!f) return "";
  const who = m.withUserId ? world.nameOf(m.withUserId) : "the human";
  const head = `## Open on ${who}'s screen\nThe decision queue has shown this ${KIND_WORD[f.kind]} since ${fromNow(f.at, now)}. "This", "it" or "this one" in ${who}'s lines means it.`;
  let body: string[] | null;
  if (f.kind === "ask") {
    const a = world.asks.get(f.id);
    body = a ? askLines(world, a, f.at) : null;
  } else {
    const line = recordLine(world, f.kind, f.id);
    body = line ? [`${KIND_WORD[f.kind][0]!.toUpperCase()}${KIND_WORD[f.kind].slice(1)} ${f.id}: ${line}`] : null;
  }
  if (!body) return `## Open on ${who}'s screen\nThe item on screen (${f.id}) is gone.`;
  return `${head}\n${body.join("\n")}`;
}

/**
 * What `act_in_1on1` acts on when the agent names no target: the focused grant, retainer or request, or the grant,
 * retainer or request the focused ask is about. Null when nothing decidable is open.
 */
export function focusTarget(world: World, m: Pick<Meeting, "focus">): string | null {
  const f = m.focus;
  if (!f) return null;
  if (f.kind === "grant" || f.kind === "retainer") return f.id;
  if (f.kind === "doc") return world.docs.get(f.id)?.type === "request" ? f.id : null;
  if (f.kind !== "ask") return null;
  const a = world.asks.get(f.id);
  if (!a?.targetId || !(a.targetKind === "grant" || a.targetKind === "retainer" || a.targetKind === "request")) return null;
  return a.targetId;
}
