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
import type { Doc, Event, Grant } from "@muster-town/schema";
import { createDoc, managerAgentOf } from "./domain.ts";
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
