/**
 * The agent panel's first line (grant gr_ukrou4zjha, findings dc_mgj5u0pion): one plain sentence on what the agent is
 * doing now, and which of its timeline lines are the town's plumbing (sessions, spend, secrets) that fold behind Details.
 */
import type { Agent, Event } from "@muster-town/schema";

/** Event types a stranger doesn't need: shown only with Details open. */
const PLUMBING = new Set<string>([
  "session.started", "session.ended", "secret.granted", "system", "agent.activity", "skill.used",
  "exploration.started", "exploration.proposed", "assignment.created", "assignment.status",
  "bank.debited", "bank.cap", "budget.exhausted",
]);
/** Words of the town's internals: a line with one folds away too. */
const INTERNAL = /\bhops?\b|adj\.? tokens|\bsession\b|\bchain\b|resumeWhen|\{deploy|\bpark(ed)?\b|\bin-tray\b|funded by|\bfork\b|transcript/i;

export function isPlumbing(e: Pick<Event, "type" | "text">): boolean {
  if (e.type === "agent.thought" || e.type === "agent.said" || e.type === "agent.told") return false;
  return PLUMBING.has(e.type) || INTERNAL.test(e.text ?? "");
}

/** The activity string in plain words: no funding note, no git branch. */
export function plainActivity(activity: string): string {
  const a = activity.replace(/\s*\(funded by [^)]*\)/i, "").trim();
  if (/^Setting up \S+\/\S+/.test(a)) return "Setting up their desk";
  return a;
}

/** The first sentence of a thought, cut at about 160 characters. */
export function firstSentence(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const s = m ? m[1] : t;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** The agent's latest thought in its current (or last) session, from the events we hold. */
export function latestThought(events: Pick<Event, "type" | "text" | "agentId">[], agentId: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.agentId !== agentId) continue;
    if (e.type === "session.started") return null;
    if (e.type === "agent.thought" && e.text.trim()) return e.text;
  }
  return null;
}

type NowInput = {
  agent: Pick<Agent, "name" | "kind" | "status" | "activity" | "forkOf">;
  /** the latest thought this session (plain sentences the agent writes for people) */
  thought?: string | null;
  /** what it's working on: its running assignment's title (ids in it render as names) */
  task?: string | null;
  /** a resting agent: the last thing it finished */
  lastDone?: string | null;
};

/** `{ now, task }`: "Now: …" in plain words, and the task it serves ("Working on …"), if any. */
export function nowLine({ agent, thought, task, lastDone }: NowInput): { now: string; task?: { label: string; title: string } } | null {
  if (agent.kind === "human") return null;
  const doing = thought && !INTERNAL.test(firstSentence(thought)) ? firstSentence(thought) : plainActivity(agent.activity ?? "");
  const working = task ? { label: "Working on", title: task } : undefined;
  const finished = lastDone ? { label: "Last finished", title: lastDone } : undefined;
  switch (agent.status) {
    case "walking": return { now: `Now: ${plainActivity(agent.activity ?? "") || "walking across town"}`, task: working };
    case "working": return { now: `Now: ${doing || "working"}`, task: working };
    case "in-meeting": return { now: `Now: in a meeting${agent.activity ? ` (${plainActivity(agent.activity)})` : ""}`, task: working };
    case "stopped": return { now: "Now: stopped. Someone in charge can let them take work again.", task: working ?? finished };
    case "out-of-budget": return { now: "Now: paused, out of tokens to spend.", task: working ?? finished };
    case "offline": return { now: "Now: offline. They run from their owner's own computer and come back when it connects.", task: working };
    case "banned": return { now: "Now: banned from the town." };
    case "retired": return agent.forkOf
      ? { now: "Done: this helper finished its one task and handed in a report.", task: task ? { label: "Its task was", title: task } : finished }
      : { now: "Retired." };
    default:
      if (agent.kind === "service") return { now: `Now: ${plainActivity(agent.activity ?? "") || "keeping the library"}` };
      return { now: `Now: resting until someone gives ${agent.name} something to do.`, task: finished };
  }
}
