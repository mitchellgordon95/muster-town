/** 1:1s (docs/waterfall.md §3.4): "Talk to ★ <manager>", a doc's "Talk to <author>" and a grant's "Talk to <manager>" open a meeting with that agent. */
import { isGone } from "@muster-town/schema";
import type { Agent } from "@muster-town/schema";
import { api } from "../api";
import { store } from "../state";

/** A human who can facilitate or review in the building (its staff). */
export const canOneOnOne = (buildingId: string | null | undefined) => !!buildingId && (store.can("meeting.facilitate", buildingId) || store.can("building.review", buildingId));

/**
 * "Talk to ★ <manager>" and a 1:1 in a building (not the Town Hall): where the server's `canDirect` holds for me (gr_cuobjlny6r,
 * /api/me `directBuildingIds`: its staff, a captain over its goal, or a member granted "direct work under" it). No permission, no Talk.
 */
export const canTalkToManager = (buildingId: string | null | undefined) =>
  !!buildingId && store.state.buildings.find((b) => b.id === buildingId)?.kind !== "town-hall" && (canOneOnOne(buildingId) || !!store.state.me?.directBuildingIds?.includes(buildingId));

/** Open (or return to) my 1:1 with the building's manager agent, or with `opts.agentId` about `opts.docId` / `opts.grantId`, in the meeting panel. */
export async function openOneOnOne(buildingId: string, opts: { agentId?: string; docId?: string; grantId?: string } = {}): Promise<void> {
  const m = await api().openOneOnOne(buildingId, opts);
  store.putMeeting(m);
  store.open({ kind: "meeting", id: m.id });
}

/** "Plan with an agent" (docs/goals.md "The planning agent"): open (or return to) my 1:1 with the Planner, the Town Hall's manager, about `goalId`. */
export async function openPlanner(goalId?: string): Promise<void> {
  const m = await api().openPlanner(goalId);
  store.putMeeting(m);
  store.open({ kind: "meeting", id: m.id });
}

/**
 * The Town Hall's Secretary (gr_kdlogzzo5s): a live resident titled "Secretary" whose home is the Town Hall, or null.
 * Its 1:1 is openOneOnOne(townHallId, { agentId }); core createOneOnOne allows it for the Planner's people.
 */
export function secretaryOf(agents: Record<string, Agent>, townHallId: string | null | undefined): Agent | null {
  if (!townHallId) return null;
  return Object.values(agents).find((a) => a.kind === "resident" && a.homeBuildingId === townHallId && a.title === "Secretary" && !a.forkOf && a.status !== "stopped" && !isGone(a)) ?? null;
}

/** Who may open a 1:1 at the Town Hall (the Planner's and the Secretary's): an admin or captain, or the Town Hall's staff. */
export const canTalkAtTownHall = (townHallId: string | null | undefined) => store.can("goals.edit") || canOneOnOne(townHallId);

const talkable = (a: Agent | undefined): boolean => !!a && a.kind === "resident" && !a.forkOf && a.status !== "stopped" && !isGone(a);

/**
 * Who a doc's "Talk to <author>" reaches (mirrors core oneOnOneTarget): the author if it's a working resident; a
 * fork's parent manager; else (gone, stopped) the manager of its building. `via` says why it isn't the author.
 */
export function talkTarget(authorId: string, agents: Record<string, Agent>, buildings: { id: string; managerAgentId?: string | null }[]): { agent: Agent; via: "fork" | "gone" | null } | null {
  const author = agents[authorId];
  if (!author || author.kind === "human") return null;
  if (talkable(author)) return { agent: author, via: null };
  const parent = author.forkOf ? agents[author.forkOf] : undefined;
  if (parent && talkable(parent)) return { agent: parent, via: "fork" };
  const home = buildings.find((b) => b.id === (author.homeBuildingId ?? author.buildingId));
  const mgr = home?.managerAgentId ? agents[home.managerAgentId] : undefined;
  return mgr && talkable(mgr) ? { agent: mgr, via: author.forkOf ? "fork" : "gone" } : null;
}

/**
 * Who a grant's "Talk to <manager>" reaches (mirrors core createOneOnOne with a grantId): its proposer resolved like a
 * doc's author when that agent works in the grant's building, else the building's manager.
 */
export function grantTalkTarget(proposedBy: string, buildingId: string, agents: Record<string, Agent>, buildings: { id: string; managerAgentId?: string | null }[]): Agent | null {
  const t = talkTarget(proposedBy, agents, buildings)?.agent;
  if (t && (t.homeBuildingId ?? t.buildingId) === buildingId) return t;
  const b = buildings.find((x) => x.id === buildingId);
  const mgr = b?.managerAgentId ? agents[b.managerAgentId] : undefined;
  return talkable(mgr) ? mgr! : null;
}
