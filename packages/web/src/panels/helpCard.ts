/**
 * What a building's "?" help sign says (Mitchell's flag dc_8dwch9z5pi): generated from the building's live data, not
 * written per building. Who it is for decides the "What you can do" lines: a signed-out stranger, someone signed in
 * and not let in yet, a member, or someone who reviews here (an admin or the building's captain).
 */
import type { Agent, Place } from "@muster-town/schema";

export type HelpViewer = "guest" | "pending" | "member" | "reviewer";
interface HelpThing { placeId: string; name: string; line: string }
interface HelpCard {
  title: string;
  goal: string;
  manager: Agent | null;
  working: Agent[];
  resting: number;
  things: HelpThing[];
  todo: string[];
}

/** One line per thing in a room, by place kind: [name, what it is]. The Town Hall's differ where its thing does. */
const LAB: Partial<Record<Place["kind"], [string, string]>> = {
  board: ["Board", "notices everyone in this building should see."],
  cabinet: ["Filing cabinet", "every report and note filed here, open to read."],
  intray: ["In-tray", "the manager's desk: reports waiting for review."],
  schedule: ["Schedule board", "this building's timed jobs."],
  "meeting-room": ["Meeting table", "where meetings happen; anyone can listen in."],
  desk: ["Desks", "where agents work. Click one to see what it's doing."],
};
const HALL: Partial<Record<Place["kind"], [string, string]>> = {
  board: ["Board", "notices for the whole town."],
  intray: ["In-tray", "proposals and summaries for humans to decide."],
  "goal-tree": ["Goal tree", "the town's goals and the work funded under them."],
  library: ["Library", "the town's best documents, open to read."],
  outbox: ["Outbox", "things agents asked humans to do."],
  stats: ["User stats", "how visitors become members, by day."],
  schedule: ["Schedule board", "every building's meetings."],
  "meeting-room": ["Meeting table", "town meetings; anyone can listen in."],
  planning: ["Planning desk", "where admins set up buildings."],
  "town-map": ["Town map table", "where buildings go on the map."],
  "mod-station": ["Mod station", "where town moderators sit."],
};
const ORDER: Place["kind"][] = ["board", "goal-tree", "library", "cabinet", "intray", "outbox", "stats", "schedule", "meeting-room", "planning", "town-map", "mod-station", "desk"];

export function helpCard(
  b: { id: string; name: string; kind: "lab" | "town-hall"; goal: string; managerAgentId?: string | null },
  places: Place[], agents: Record<string, Agent>,
  viewer: HelpViewer, can: { talk: boolean; flag: boolean; touch: boolean },
): HelpCard {
  const hall = b.kind === "town-hall", lines = hall ? HALL : LAB;
  const here = places.filter((p) => p.buildingId === b.id);
  const things: HelpThing[] = [];
  for (const kind of ORDER) {
    const l = lines[kind];
    // desks: the first one with an agent at it, else the first free one
    const p = kind === "desk" ? here.find((x) => x.kind === "desk" && !x.id.startsWith("desk:free:")) ?? here.find((x) => x.kind === "desk") : here.find((x) => x.kind === kind);
    if (l && p) things.push({ placeId: p.id, name: l[0], line: kind === "desk" && can.touch ? l[1].replace("Click", "Tap") : l[1] });
  }
  const people = Object.values(agents).filter((a) => a.buildingId === b.id && (a.kind === "resident" || a.kind === "visitor") && a.status !== "retired" && a.status !== "stopped");
  const working = people.filter((a) => a.status === "working" || a.status === "in-meeting").sort((x, y) => x.name.localeCompare(y.name));
  // the Town Hall's manager is the root goal's captain (a human), not the Planner: no ★ there (1:1 mt_1vs893enaw)
  const manager = !hall && b.managerAgentId ? agents[b.managerAgentId] ?? null : null;
  const click = can.touch ? "Tap" : "Click";
  const read = hall ? "Read the board, the library and the goal tree" : "Read the board and the filing cabinet";
  const talk = can.talk && manager ? [`Talk to the manager: ${click.toLowerCase()} ★ ${manager.name}, then Talk.`] : [];
  const flag = can.flag ? [`Plant a flag${can.touch ? "" : " (F)"} to ask this building for something.`] : [];
  const todo =
    viewer === "guest" ? [`${read}: everything here is public.`, `${click} an agent to see what it's doing now.`, "To join in, sign in with GitHub, then Ask to join."]
    : viewer === "pending" ? [`${read}: everything here is public.`, "Ask to join on your card at the top left; an admin lets you in."]
    : viewer === "member" ? [...talk, `${read}: every report is filed there.`, ...flag]
    : [hall ? "Decide proposals and grants in the in-tray." : "Review reports in the in-tray: approve, continue or redirect.", ...talk, ...flag];
  return { title: b.name, goal: b.goal, manager, working, resting: people.length - working.length, things, todo };
}
