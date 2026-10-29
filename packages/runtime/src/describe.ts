/** Readable one-liners for tool calls (drive `agent.tool` events and the live bubbles). */
import type { World } from "@muster-town/core";

const clip = (s: unknown, n = 80) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

export function hostOf(url: unknown): string {
  try { return new URL(String(url)).hostname.replace(/^www\./, ""); } catch { return clip(url, 40); }
}

function placeName(world: World, to: string): string {
  const p = world.layout.place(to);
  if (p) return ["library", "outbox", "plaza"].includes(p.id) ? p.name.toLowerCase() : p.name;
  const a = world.agents.get(to);
  return a ? a.name : to;
}

export function describeTool(world: World, name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === "WebSearch") return `Searching the web: ${clip(i.query)}`;
  if (name === "WebFetch") return `Reading ${hostOf(i.url)}`;
  const verb = name.startsWith("mcp__town__") ? name.slice("mcp__town__".length) : null;
  if (!verb) return describeBuiltin(name, i);
  switch (verb) {
    case "look": return "Looking around";
    case "go": return `Walking to ${placeName(world, String(i.to ?? ""))}`;
    case "say": return `Saying: ${clip(i.text)}`;
    case "tell": return `Messaging ${world.nameOf(String(i.to ?? ""))}`;
    case "inbox": return "Checking inbox";
    case "board": return "Reading the board";
    case "search": return `Searching the library: ${clip(i.query)}`;
    case "read": {
      const d = world.docs.get(String(i.id ?? ""));
      return d ? `Reading "${clip(d.title, 60)}"` : `Reading doc ${clip(i.id, 20)}`;
    }
    case "write": return `Writing ${String(i.type ?? "note")} "${clip(i.title, 60)}"`;
    case "submit_report": return `Submitting report: ${clip(i.title, 60)}`;
    case "request_human": return `Asking humans for help: ${clip(i.title, 60)}`;
    case "assignments": return "Checking assignments";
    case "accept_assignment": return "Accepting an assignment";
    case "meeting": {
      const a = String(i.action ?? "status");
      if (a === "speak") return `In the meeting: ${clip(i.text)}`;
      if (a === "listen") return "Listening in the meeting";
      if (a === "decide") return "Recording meeting decisions";
      if (a === "end") return "Closing the meeting";
      if (a === "summary") return "Submitting a meeting summary";
      return "Checking the meeting";
    }
    case "review": return `Reviewing a report: ${String(i.decision ?? "")}`;
    case "assign": return `Assigning work to ${world.nameOf(String(i.agentId ?? ""))}`;
    case "reassign": return `Reassigning work to ${world.nameOf(String(i.agentId ?? ""))}`;
    case "cancel": return "Cancelling a queued assignment";
    case "propose_grant": return `Proposing a grant: ${clip(i.objective, 60)}`;
    case "checkpoint_grant": return "Filing a grant checkpoint";
    case "close_grant": return "Closing a grant as done";
    case "set_objective": return i.id ? "Editing an objective" : `Writing an objective: ${clip(i.text, 60)}`;
    case "set_key_result": return i.id ? "Editing a key result" : `Writing a key result: ${clip(i.text, 60)}`;
    case "promote": return `Promoting a doc to the ${i.state === "library" ? "library" : "board"}`;
    case "ban": return `Banning ${world.nameOf(String(i.agentId ?? ""))}`;
    default: return `Using ${verb}`;
  }
}

/** Desk sessions use Claude Code's built-in tools; make them read like activity, not tool names. */
function describeBuiltin(name: string, i: Record<string, unknown>): string {
  const file = (p: unknown) => String(p ?? "").replace(/^\/home\/agent\/work\/[^/]+\//, "").slice(-60);
  switch (name) {
    case "Bash": {
      const cmd = String(i.command ?? "").replace(/\s+/g, " ").trim();
      const desc = typeof i.description === "string" && i.description.trim() ? i.description.trim() : cmd;
      return `Running: ${clip(desc, 70)}`;
    }
    case "Read": return `Reading ${file(i.file_path)}`;
    case "Write": return `Writing ${file(i.file_path)}`;
    case "Edit": case "MultiEdit": return `Editing ${file(i.file_path)}`;
    case "Glob": return `Looking for ${clip(i.pattern, 50)}`;
    case "Grep": return `Grepping for ${clip(i.pattern, 50)}`;
    case "TodoWrite": return "Updating plan";
    case "Task": case "Agent": return "Delegating a sub-task";
    default: return `Using ${name}`;
  }
}
