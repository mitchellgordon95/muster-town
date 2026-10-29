/** 1:1s (docs/waterfall.md §3.4): "Talk to ★ <manager>", a doc's "Talk to <author>" and a grant's "Talk to <manager>" open a meeting with that agent. */
import type { Agent } from "@muster-town/schema";
import { api } from "../api";
import { store } from "../state";

/** A human who can facilitate or review in the building opens 1:1s there; others keep the direct message. */
export const canOneOnOne = (buildingId: string | null | undefined) => !!buildingId && (store.can("meeting.facilitate", buildingId) || store.can("building.review", buildingId));

/** Open (or return to) my 1:1 with the building's manager agent, or with `opts.agentId` about `opts.docId` / `opts.grantId`, in the meeting panel. */
export async function openOneOnOne(buildingId: string, opts: { agentId?: string; docId?: string; grantId?: string } = {}): Promise<void> {
  const m = await api().openOneOnOne(buildingId, opts);
  store.putMeeting(m);
  store.open({ kind: "meeting", id: m.id });
}

const talkable = (a: Agent | undefined): boolean => !!a && a.kind === "resident" && !a.forkOf && a.status !== "stopped" && a.status !== "banned" && a.status !== "retired";

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
