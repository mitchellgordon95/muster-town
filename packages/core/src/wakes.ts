/**
 * Manager wakes on grant and key-result events (docs/wakes.md §4 step 3). A human's decision on a grant, or a human
 * writing, editing, marking or removing a key result of a building's goal, becomes one town-written report in that
 * building's in-tray (author "system", shown as Town); the runtime's `doc.created` branch then wakes (or feeds) the
 * manager's team-lead session, the same path as a resident's report. The manager acknowledges it with `review` approve.
 *
 * Events that already wake the manager with an assignment are left out: fund, counter and reject
 * (`Grants.decisionAssignment`) and `grant.checkpoint`. Each row carries the tag `wake:<rule>:<eventId>:<buildingId>`,
 * so delivering the same event twice writes nothing the second time.
 */
import type { Agent, Assignment, Doc, Event, Grant } from "@muster-town/schema";
import { createAssignment, createDoc, managerAgentOf, moveToFront } from "./domain.ts";
import { DIRECTED } from "./lanes.ts";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";

const RULE = "manager-intray";

/** The tag that makes the row for `e` unique. */
export const wakeKey = (e: Event, buildingId: string) => `wake:${RULE}:${e.id}:${buildingId}`;

/** The in-tray row `e` calls for, written once; null when the event is not one (or it was already written). */
export function managerIntrayRow(world: World, e: Event): Doc | null {
  const row = describe(world, e);
  if (!row || !e.buildingId) return null;
  const building = world.buildings.get(e.buildingId);
  if (!building || building.kind === "town-hall" || !managerAgentOf(world, building)) return null;
  const key = wakeKey(e, building.id);
  if (world.docs.first("authorId = 'system' AND buildingId = ? AND tags LIKE ?", [building.id, `%"${key}"%`])) return null;
  return createDoc(world, {
    type: "report", state: "building", decision: "pending", buildingId: building.id, authorId: "system", authorKind: "user",
    tags: [RULE, key], title: row.title.slice(0, 200),
    body: [
      `Written by the town: ${row.what} (event ${e.id}, ${e.ts.slice(0, 16).replace("T", " ")} UTC).`,
      `## Summary\n\n${row.summary}`,
      "Acknowledge it with `review` approve once you've taken it in; give any work it calls for with `assign`.",
    ].join("\n\n"),
  }, `Town wrote "${row.title.slice(0, 100)}" in ${building.name}'s in-tray`);
}

/** Title, one-line what and summary for a grant or key-result event a human caused; null for any other event. */
function describe(world: World, e: Event): { title: string; what: string; summary: string } | null {
  const p = e.payload as Record<string, unknown>;
  const human = humanName(world, e);
  if (!human) return null;
  if (e.type === "grant.funded" || e.type === "grant.closed") {
    const action = String(p.action ?? "");
    // fund has its own assignment (Grants.decisionAssignment); a manager closing its own grant is not a human event
    if (e.type === "grant.funded" && action !== "continue" && action !== "adjust") return null;
    const g = world.grants.get(String(p.grantId));
    if (!g) return null;
    const note = g.history.at(-1)?.note.trim();
    const verb = e.type === "grant.closed" ? (action === "cut" ? "cut" : `closed (${g.outcome ?? "closed"})`) : action === "adjust" ? "adjusted" : "continued";
    const tokens = e.type === "grant.funded" ? `: ${fmt(g.grantTokens ?? 0)} tokens` : "";
    return {
      title: `Grant ${g.id} ${verb}${tokens}`,
      what: `${human} ${verb} grant ${g.id} at its checkpoint`,
      summary: [`Grant ${g.id} "${g.objective}" ${verb} by ${human}${tokens}.`, grantLine(world, g), ...(note ? [`The note: ${note}`] : [])].join("\n\n"),
    };
  }
  if (e.type === "kr.created" || e.type === "kr.updated" || e.type === "kr.deleted") {
    const id = String(p.keyResultId);
    const kr = world.keyResults.get(id);
    const text = kr?.text ?? String(p.text ?? e.text);
    let verb: string, detail: string;
    if (e.type === "kr.created") { verb = "written"; detail = `How to check: ${kr?.howToCheck ?? p.howToCheck ?? ""}`; }
    else if (e.type === "kr.deleted") { verb = "removed"; detail = "It is no longer on the goal; work that named it keeps running until you reassign it."; }
    else if (p.edited === true) { verb = "edited"; detail = `Was: ${String(p.fromText ?? "")}\nNow: ${text}\nHow to check: ${kr?.howToCheck ?? ""}`; }
    else { verb = `marked ${String(p.status)}`; detail = `Status ${String(p.from)} → ${String(p.status)}${kr?.statusNote ? `: ${kr.statusNote}` : ""}`; }
    return {
      title: `Key result ${id} ${verb} by ${human}`,
      what: `key result ${id} of the building goal was ${verb} by ${human}`,
      summary: `Key result ${id}: ${text}\n\n${detail}${p.grantId ? `\n\nGrant ${String(p.grantId)} works on it.` : ""}`,
    };
  }
  return null;
}

/** The human (an avatar or a user) behind the event, by name; null when an agent or the system acted. */
function humanName(world: World, e: Event): string | null {
  const p = e.payload as Record<string, unknown>;
  if (p.byKind === "user" && typeof p.by === "string") return world.nameOf(p.by);
  const a = e.agentId ? world.agents.get(e.agentId) : undefined;
  return a?.kind === "human" ? a.name : null;
}

const grantLine = (world: World, g: Grant) => {
  const kr = g.keyResultId ? world.keyResults.get(g.keyResultId) : undefined;
  return `Status ${g.status}; ${fmt(world.grantDesk.view(g).spentTokens)} of ${fmt(g.grantTokens ?? 0)} tokens spent; key result ${kr ? `${kr.id} [${kr.status}] ${kr.text}` : "(none named)"}.`;
};

const fmt = (n: number) => n.toLocaleString("en-US");

/** Step 2: a relayed tell wakes only within this many hops of the human, and this long after the human acted. */
export const RELAY_MAX_HOPS = 3;
export const RELAY_MAX_AGE_MS = 24 * 3600_000;
const RELAY_PREFIX = "Message from ";

/** The line that makes the relay of `told` (an `agent.told` event) to `agentId` unique; it sits in the description. */
export const relayKey = (eventId: number | string, agentId: string) => `wake:relay:${eventId}:${agentId}`;

/**
 * Wakes step 2 (docs/wakes.md §4): a tell that traces to a human (`payload.origin`), sent to an idle resident, becomes a
 * pending directed "Message from <human> (via <sender>)" assignment with the text, or is merged into the one already
 * waiting for the same human and path. Inbox only (null) when it has no origin, is more than RELAY_MAX_HOPS relays or
 * 24 h from the human, the recipient is not an idle resident or has a work session running, or it was already relayed.
 * The scheduler's `canStart` stays the only gate on whether it runs.
 */
export function relayWake(world: World, from: Agent, told: Event): Assignment | null {
  const p = told.payload as { toId?: string; text?: string; origin?: Assignment["origin"] };
  const origin = p.origin;
  const to = p.toId ? world.agents.get(p.toId) : undefined;
  if (!origin || !to || to.kind !== "resident" || typeof p.text !== "string") return null;
  if (origin.hops > RELAY_MAX_HOPS || Date.now() - Date.parse(origin.at) > RELAY_MAX_AGE_MS) return null;
  if (to.status !== "idle" && to.status !== "out-of-budget") return null;
  if (world.sessions.count("agentId = ? AND status = 'running' AND purpose = 'work'", [to.id]) > 0) return null;
  const key = relayKey(told.id, to.id);
  if (world.assignments.first("agentId = ? AND description LIKE ?", [to.id, `%${key}%`])) return null;
  const human = world.nameOf(origin.userId);
  const tail = `\n\nReply to ${from.name} with \`tell\` (id ${from.id}) when it is done; it traces to ${human}.\n\n(${key})`;
  const pending = world.assignments.where("agentId = ? AND status = 'pending' AND title LIKE ?", [to.id, `${RELAY_PREFIX}%`])
    .find((a) => a.origin?.userId === origin.userId && a.origin.via === origin.via);
  if (pending) {
    const merged = world.assignments.upsert({ ...pending, description: `${pending.description}\n\nThen ${from.name} added:\n\n${p.text}${tail}`, updatedAt: nowIso() });
    return moveToFront(world, merged.id);
  }
  const first = p.text.split("\n")[0].trim();
  return createAssignment(world, {
    agentId: to.id, createdBy: { kind: "agent", id: from.id }, front: true, origin,
    laneOverride: { ...DIRECTED, sourceId: origin.via },
    title: `${RELAY_PREFIX}${human} (via ${from.name}): ${first.length > 80 ? first.slice(0, 79) + "…" : first}`,
    description: `${from.name} messaged you for ${human} (${origin.hops} hop${origin.hops === 1 ? "" : "s"} from them):\n\n${p.text}${tail}`,
  });
}
