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

const REVIEW: Record<string, string> = {
  approve: "Approving a report",
  continue: "Approving a report and its next step",
  redirect: "Redirecting a report's next step",
  stop: "Stopping an agent after a report",
};

export function describeTool(world: World, name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === "WebSearch") return `Searching the web: ${clip(i.query)}`;
  if (name === "WebFetch") return `Reading ${hostOf(i.url)}`;
  const verb = name.startsWith("mcp__town__") ? name.slice("mcp__town__".length) : null;
  if (!verb) return describeBuiltin(name, i);
  switch (verb) {
    case "look": return "Looking around";
    case "town": return "Looking up the town's buildings";
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
    case "write": {
      if (i.type === "log") return "Writing a log line";
      if (i.type === "wiki") return `Updating page "${clip(i.title, 60)}"`;
      return `Writing ${String(i.type ?? "note")} "${clip(i.title, 60)}"`;
    }
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
    case "review": return REVIEW[String(i.decision)] ?? "Reviewing a report";
    case "assign": return i.agentId
      ? `Assigning work to ${world.nameOf(String(i.agentId))}: ${clip(i.title, 60)}`
      : `Queuing work: ${clip(i.title, 60)}`;
    case "cancel": return i.scheduleId ? "Cancelling a schedule" : "Cancelling a queued assignment";
    case "fork_status": return `Checking on ${world.nameOf(String(i.forkId ?? "")) || "a fork"}`;
    case "stop_fork": return `Asking ${i.forkId ? world.nameOf(String(i.forkId)) : "a fork"} to wrap up and stop`;
    case "schedule": return `Scheduling: ${clip(i.title, 60)}`;
    case "propose_grant": return `Proposing a grant: ${clip(i.objective, 60)}`;
    case "checkpoint_grant": return "Filing a grant checkpoint";
    case "close_grant": return "Closing a grant as done";
    case "set_objective": return i.id ? "Editing an objective" : `Writing an objective: ${clip(i.text, 60)}`;
    case "propose_goal": return `Proposing a goal change (${i.action})`;
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
      if (typeof i.description === "string" && i.description.trim()) return `Running: ${clip(i.description, 70)}`;
      return describeCommand(String(i.command ?? ""));
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

/** Programs that only set the stage (cd, export, wrappers): the bubble names what runs after them. */
const PRELUDE = new Set(["cd", "pushd", "popd", "export", "set", "unset", "source", ".", "true", ":", "ulimit", "umask", "env", "sudo", "time", "nohup", "exec", "command", "nice", "then", "do", "if", "!", "{", "("]);

/** A Bash call with no description, in plain words: never the raw command, its paths or its env vars. */
export function describeCommand(command: string): string {
  // Heredoc bodies and later lines are data or follow-ups; the first line names the work.
  const firstLine = command.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
  let weak: string | null = null; // echo/sleep: only if nothing else runs
  for (const segment of firstLine.split(/&&|\|\||;|\|/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^[('"]+|['")]+$/g, ""));
    while (words.length && (PRELUDE.has(words[0]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!))) {
      const w = words.shift()!;
      if (["cd", "pushd", "source", "."].includes(w)) words.length = 0; // its argument is a path, not a program
    }
    if (words[0] === "timeout") words.splice(0, /^\d/.test(words[1] ?? "") ? 2 : 1);
    if (!words.length) continue;
    const said = describeProgram(words, command);
    if (said && WEAK.has(said)) weak ??= said;
    else if (said) return said;
  }
  return weak ?? "Running a shell command";
}

const WEAK = new Set(["Waiting", "Printing a note"]);
const TESTS = /^(test|tests|vitest|jest|pytest|mocha|check)(:|$)/;

function describeProgram(words: string[], whole: string): string | null {
  const prog = (words[0] ?? "").replace(/^.*\//, "").replace(/^(python|node)[\d.]*$/, "$1");
  const rest = words.slice(1).filter((w) => !w.startsWith("-"));
  switch (prog) {
    case "python": return words.includes("pytest") ? "Running tests" : words.includes("pip") ? "Installing Python packages" : "Running a Python script";
    case "node": case "tsx": case "deno": case "bun": case "ts-node": return "Running a Node script";
    case "curl": case "wget": case "http":
      return /AGENT_TOWN|muster\.town|localhost|127\.0\.0\.1/.test(whole) ? "Calling the town API" : "Calling a web API";
    case "git": {
      const sub = words.slice(1).find((w, k, a) => !w.startsWith("-") && !["-C", "-c"].includes(a[k - 1] ?? ""));
      return sub && /^[a-z-]+$/.test(sub) ? `Working with git (${sub})` : "Working with git";
    }
    case "gh": return rest[0] && /^[a-z-]+$/.test(rest[0]) ? `Working with GitHub (${rest[0]})` : "Working with GitHub";
    case "npm": case "pnpm": case "yarn": case "npx": case "pnpx": {
      const script = (["run", "exec", "x"].includes(rest[0] ?? "") ? rest[1] : rest[0]) ?? "";
      if (TESTS.test(script)) return "Running tests";
      if (/^(typecheck|tsc)/.test(script)) return "Type-checking the code";
      if (/^(install|i|ci|add)$/.test(script)) return "Installing packages";
      if (/^build/.test(script)) return "Building the code";
      if (/^(lint|eslint|knip)/.test(script)) return "Linting the code";
      return prog === "npx" || prog === "pnpx" ? "Running a Node tool" : "Running an npm script";
    }
    case "vitest": case "jest": case "pytest": case "mocha": return "Running tests";
    case "tsc": return "Type-checking the code";
    case "pip": case "pip3": case "uv": return "Installing Python packages";
    case "grep": case "rg": case "ag": case "find": case "fd": case "egrep": return "Searching files";
    case "cat": return words.some((w) => w.startsWith(">")) ? "Writing a file" : "Reading files";
    case "head": case "tail": case "less": case "wc": case "diff": return "Reading files";
    case "sed": case "awk": return words.some((w) => /^-i/.test(w)) ? "Editing files" : "Reading files";
    case "ls": case "tree": case "du": case "stat": return "Listing files";
    case "mkdir": case "cp": case "mv": case "rm": case "touch": case "chmod": case "ln": return "Managing files";
    case "tar": case "unzip": case "gzip": case "zip": return "Packing or unpacking files";
    case "jq": return "Reading JSON";
    case "sqlite3": case "psql": return "Querying a database";
    case "docker": return "Working with Docker";
    case "fly": case "flyctl": return "Working with Fly";
    case "make": return "Building the code";
    case "sleep": return "Waiting";
    case "echo": case "printf": return "Printing a note";
    case "bash": case "sh": case "zsh": {
      const c = words.indexOf("-c");
      return c >= 0 ? describeCommand(words.slice(c + 1).join(" ")) : "Running a shell script";
    }
    default: return null;
  }
}
