/** Readable one-liners for tool calls (drive `agent.tool` events and the live bubbles). */
import type { World } from "@muster-town/core";

const clip = (s: unknown, n = 80) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

function hostOf(url: unknown): string {
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
    case "withdraw_request": return `Withdrawing the outbox request ${i.docId}`;
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
    case "propose_grant": return `Proposing a grant: ${clip(i.title ?? i.objective, 60)}`;
    case "close_grant": return "Closing a grant as done";
    case "withdraw_grant": return "Withdrawing a grant proposal";
    case "ask": return `Asking the humans: ${clip(i.title, 60)}`;
    case "act_in_1on1": return `Doing what the human said: ${i.action} ${i.targetId}`;
    case "propose_goal": return `Proposing a goal change (${i.action})`;
    case "promote": return `Promoting a doc to the ${i.state === "library" ? "library" : "board"}`;
    case "calibrate": return i.body ? "Filing the calibration ask" : "Reading the budget measures";
    case "rank": return i.pattern ? "Filing the week's pattern note" : i.week ? "Reading the week" : i.order || i.slate || i.defer ? "Ranking the open asks" : "Reading the open asks";
    case "ban": return `Banning ${world.nameOf(String(i.agentId ?? ""))}`;
    default: return `Using ${verb}`;
  }
}

/** Desk sessions use Claude Code's built-in tools; make them read like activity, not tool names. */
function describeBuiltin(name: string, i: Record<string, unknown>): string {
  // The file's name only: a stranger reads "Editing overlay.ts", not a path.
  const file = (p: unknown) => clip(String(p ?? "").split("/").filter(Boolean).pop() ?? "a file", 60);
  switch (name) {
    case "Bash": {
      if (typeof i.description === "string" && i.description.trim()) return `Running: ${clip(withoutFolders(i.description), 70)}`;
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

/** The generic lines that name nothing: the census (scripts/tool-label-census.mjs) counts their share of tool lines. */
export const GENERIC_LINES: ReadonlySet<string> = new Set([
  "Reading files", "Searching files", "Editing files", "Listing files", "Managing files", "Making a folder", "Writing a file",
  "Comparing files", "Running a Python script", "Running a Node script", "Running a Node tool", "Running an npm script",
  "Running a shell command", "Running a shell script", "Opening a headless browser", "Printing a note", "Waiting",
]);

/** What a tool line must never show: a full path (`/x`, `~/x`, `./x`, `a/b/c`), an env var's value or a `$VAR`. */
export const LEAK = /(?:^|[\s("'`])(?:~|\.{1,2})?\/[\w.@-]|[\w.@-]+\/[\w.@-]+\/[\w.@*-]|\b[A-Z][A-Z0-9_]{2,}=\S|\$\{?[A-Za-z_]/;

/** An agent's own words with every full path cut to its last name (`packages/web/src/x.ts` → x.ts). */
const withoutFolders = (s: string) => s.replace(/(?<![\w.@~-])(?:~|\.{1,2})?\/?(?:[\w.@-]+\/){2,}([\w.@*-]*)|(?<![\w.@~-])(?:~|\.{1,2})?\/(?:[\w.@-]+\/)*([\w.@*-]+)/g, (_m, a, b) => a || b || "");

/** Programs that only set the stage (cd, export, wrappers): the bubble names what runs after them. */
const PRELUDE = new Set(["cd", "pushd", "popd", "export", "set", "unset", "source", ".", "true", ":", "ulimit", "umask", "env", "sudo", "time", "nohup", "exec", "command", "nice", "then", "do", "if", "until", "while", "!", "{", "(", "for", "else"]);

/** One simple command of a shell line: its words (quotes removed) and where `>` / `>>` / `tee` send its output. */
type Simple = { words: string[]; out: string | null };

/**
 * Split one shell line into simple commands at `;`, `&&`, `||`, `|` and `&` outside quotes, and each into words with
 * their quotes removed. Redirections leave the words: `> file` becomes `out`, `2>&1`, `< in` and `<<'EOF'` are dropped.
 */
function shellSplit(line: string): Simple[] {
  const cmds: Simple[] = [];
  let words: string[] = [];
  let cur: string | null = null;
  let quote: "'" | '"' | null = null;
  const endWord = () => { if (cur !== null) words.push(cur); cur = null; };
  const endCmd = () => {
    endWord();
    const out: Simple = { words: [], out: null };
    for (let k = 0; k < words.length; k++) {
      const w = words[k]!;
      const redir = /^(\d*|&)(>>?|<<?-?|<)(.*)$/.exec(w);
      if (!redir) { out.words.push(w); continue; }
      const [, , op, rest] = redir;
      const target = rest || words[++k] || "";
      if (op!.startsWith(">") && !target.startsWith("&")) out.out = target;
    }
    if (out.words.length || out.out) cmds.push(out);
    words = [];
  };
  for (let k = 0; k < line.length; k++) {
    const c = line[k]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && k + 1 < line.length) cur += line[++k]!;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur ??= ""; continue; }
    if (c === "\\" && k + 1 < line.length) { cur = (cur ?? "") + line[++k]!; continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    if (c === ";" || c === "|" || (c === "&" && line[k - 1] !== ">" && line[k + 1] !== ">")) {
      if ((c === "|" || c === "&") && line[k + 1] === c) k++;
      endCmd();
      continue;
    }
    cur = (cur ?? "") + c;
  }
  endCmd();
  return cmds;
}

/** A file's own name from a path, when it is plainly one (`grants.ts`, `*.test.ts`, `AGENTS.md`): never its folders. */
function fileName(arg: string | undefined): string | null {
  if (!arg || arg.startsWith("-") || /[$`=<>{}]/.test(arg)) return null;
  const base = arg.replace(/\/+$/, "").split("/").pop() ?? "";
  return base.length <= 40 && /^(?:[\w@*+-][\w@*.+-]*\.[A-Za-z][\w]{0,7}|Makefile|Dockerfile)$/.test(base) ? base : null;
}

/** A folder's own name (`ls packages/core/migrations` → migrations); null for `~`, `.`, `/` and anything odd. */
function folderName(arg: string | undefined): string | null {
  if (!arg || arg.startsWith("-") || /[$`=]/.test(arg)) return null;
  const base = arg.replace(/\/+$/, "").split("/").pop() ?? "";
  return /^[\w@+-][\w@.+-]{0,29}$/.test(base) ? base : null;
}

/**
 * A search term a stranger can read: `captain\|access` → "captain, access". Null when it carries a path, an env
 * var, a NAME=value or something that looks like a secret; the line then names the file or says "Searching files".
 */
function searchTerm(raw: string | undefined): string | null {
  if (!raw) return null;
  let t = raw.replace(/\\\|/g, "\u0001").replace(/\\[bBwWsSdD<>]/g, "").replace(/\\(.)/g, "$1").replace(/^\^|\$$/g, "");
  t = t.split(/\u0001|\|/)
    .map((s) => s.replace(/\.[*+]\??/g, " ").replace(/^\^|\$$/g, "").replace(/[([{]+$/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean).join(", ");
  if (!t || /[/$`]|[A-Za-z_]\w*=\S|\b(gh[pousr]_|sk-|xox[bp]-)\w|[A-Za-z0-9+]{32,}/.test(t)) return null;
  return clip(t, 40);
}

/** Positional arguments, skipping flags and the values of the flags in `takes` (e.g. `-A 3`, `--glob '*.ts'`). */
function positionals(args: string[], takes: string[] = []): { pos: string[]; vals: Map<string, string> } {
  const pos: string[] = [];
  const vals = new Map<string, string>();
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === "--") { pos.push(...args.slice(k + 1)); break; }
    if (a.startsWith("-") && a.length > 1) {
      const eq = a.indexOf("=");
      if (eq > 0) vals.set(a.slice(0, eq), a.slice(eq + 1));
      else if (takes.includes(a)) vals.set(a, args[++k] ?? "");
      continue;
    }
    pos.push(a);
  }
  return { pos, vals };
}

/** The first file the arguments name, as its own name only. */
const firstFile = (args: string[]) => args.map(fileName).find(Boolean) ?? null;

/** A Bash call with no description, in plain words: the file's own name or the search term at most, never the raw command, a path or an env var. */
export function describeCommand(command: string): string {
  // Heredoc bodies and later lines are data or follow-ups; the first line names the work (the body may name its file).
  const lines = command.split("\n");
  const at = lines.findIndex((l) => l.trim() && !l.trim().startsWith("#"));
  const firstLine = at >= 0 ? lines[at]!.trim() : "";
  const body = at >= 0 ? lines.slice(at + 1).join("\n") : "";
  let weak: string | null = null; // echo/sleep/mkdir: only if nothing else runs
  for (const simple of shellSplit(firstLine)) {
    const words = simple.words.map((w) => w.replace(/^[('"]+|['")]+$/g, "")).filter(Boolean);
    while (words.length && (PRELUDE.has(words[0]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!))) {
      const w = words.shift()!;
      if (["cd", "pushd", "source", ".", "for"].includes(w)) words.length = 0; // its argument is a path or a list, not a program
    }
    if (words[0] === "timeout") words.splice(0, /^\d/.test(words[1] ?? "") ? 2 : 1);
    if (!words.length) continue;
    const said = describeProgram(words, simple.out, command, body);
    if (said && WEAK.has(said)) weak ??= said;
    else if (said) return said;
  }
  return weak ?? "Running a shell command";
}

const WEAK = new Set(["Waiting", "Printing a note", "Managing files", "Making a folder"]);
const TESTS = /^(test|tests|vitest|jest|pytest|mocha|check)(:|$)/;
/** A source or data file a script names in quotes (`p = 'packages/web/src/panels/GrantPanel.tsx'`). */
const QUOTED_FILE = /["'`]([^"'`\s$]*\.(?:tsx?|mts|mjs|cjs|jsx?|css|html|md|json|ya?ml|sql|py|sh|toml|txt|csv))["'`]/;
const TOWN_URL = /AGENT_TOWN|MUSTER_TOWN|muster\.town|localhost|127\.0\.0\.1/;

/** A script run inline (`python3 - <<EOF`, `node -e`): the file it names, else the API it calls, else the generic line. */
function inlineScript(kind: string, code: string): string {
  const f = fileName(QUOTED_FILE.exec(code)?.[1]);
  if (f) return `Running a ${kind} script on ${f}`;
  if (/urlopen|requests\.|fetch\(|https?:\/\//.test(code)) return TOWN_URL.test(code) ? "Calling the town API" : "Calling a web API";
  return `Running a ${kind} script`;
}

function describeSearch(args: string[], takes: string[]): string {
  const { pos, vals } = positionals(args, takes);
  const pattern = vals.get("-e") ?? vals.get("--regexp") ?? pos.shift();
  const term = searchTerm(pattern);
  const files = pos.map(fileName).filter((f) => f && !f.includes("*"));
  if (term && files.length === 1) return `Searching ${files[0]} for ${term}`;
  if (term) return `Searching for ${term}`;
  return files.length === 1 ? `Searching ${files[0]}` : "Searching files";
}

function describeProgram(words: string[], out: string | null, whole: string, body: string): string | null {
  const prog = (words[0] ?? "").replace(/^.*\//, "").replace(/^(python|node)[\d.]*$/, "$1");
  const args = words.slice(1);
  const rest = args.filter((w) => !w.startsWith("-"));
  const written = fileName(out ?? undefined);
  switch (prog) {
    case "python": {
      if (words.includes("pytest")) return "Running tests";
      if (words.includes("pip")) return "Installing Python packages";
      const script = fileName(rest[0]);
      if (script && script.endsWith(".py")) return `Running ${script}`;
      return inlineScript("Python", body || whole);
    }
    case "node": case "tsx": case "deno": case "bun": case "ts-node": {
      const script = fileName(rest[0]);
      if (script) return `Running ${script}`;
      return inlineScript("Node", body || whole);
    }
    case "curl": case "wget": case "http":
      return TOWN_URL.test(whole) ? "Calling the town API" : "Calling a web API";
    case "git": {
      const k = words.findIndex((w, j) => j > 0 && !w.startsWith("-") && !["-C", "-c"].includes(words[j - 1] ?? ""));
      const sub = k > 0 ? words[k]! : undefined;
      if (sub === "grep") return describeSearch(words.slice(k + 1), ["-e", "-A", "-B", "-C", "-m"]);
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
      if (script === "tsx" || script === "node") { const f = fileName(rest[rest.indexOf(script) + 1]); if (f) return `Running ${f}`; }
      return prog === "npx" || prog === "pnpx" ? "Running a Node tool" : "Running an npm script";
    }
    case "vitest": case "jest": case "pytest": case "mocha": return "Running tests";
    case "tsc": return "Type-checking the code";
    case "pip": case "pip3": case "uv": return "Installing Python packages";
    case "grep": case "egrep": case "fgrep": return describeSearch(args, ["-e", "-f", "-A", "-B", "-C", "-m", "--include", "--exclude", "--exclude-dir"]);
    case "rg": case "ag": return describeSearch(args, ["-e", "-g", "-t", "-T", "-A", "-B", "-C", "-m", "--glob", "--type"]);
    case "find": case "fd": {
      const { vals } = positionals(args, ["-name", "-iname", "-path", "-type", "-maxdepth", "-mindepth", "-newer", "-mtime", "-size"]);
      const name = fileName(vals.get("-name") ?? vals.get("-iname")) ?? searchTerm(vals.get("-name") ?? vals.get("-iname"));
      return name ? `Looking for ${name}` : "Searching files";
    }
    case "cat": {
      if (written) return `Writing ${written}`;
      if (out) return "Writing a file";
      const f = firstFile(rest);
      return f ? `Reading ${f}` : "Reading files";
    }
    case "tee": { const f = firstFile(rest); return f ? `Writing ${f}` : "Writing a file"; }
    case "head": case "tail": case "less": case "more": case "wc": case "nl": {
      const f = firstFile(positionals(args, ["-n", "-c"]).pos);
      return f ? `Reading ${f}` : "Reading files";
    }
    case "diff": case "cmp": { const f = firstFile(rest); return f ? `Comparing ${f}` : "Comparing files"; }
    case "sed": case "awk": case "gawk": {
      const { pos, vals } = positionals(args, prog === "sed" ? ["-e", "-f"] : ["-F", "-v", "-f"]);
      const files = vals.has("-e") || vals.has("-f") ? pos : pos.slice(1); // the first positional is the script
      const f = firstFile(files);
      if (args.some((w) => /^-i/.test(w)) || written) return f || written ? `Editing ${f ?? written}` : "Editing files";
      return f ? `Reading ${f}` : "Reading files";
    }
    case "ls": case "tree": case "du": {
      const target = rest[rest.length - 1];
      const f = fileName(target);
      if (f) return `Listing ${f}`;
      const d = folderName(target);
      return d ? `Listing the ${d} folder` : "Listing files";
    }
    case "stat": return "Listing files";
    case "mkdir": return "Making a folder";
    case "cp": case "mv": case "rm": case "touch": case "chmod": case "ln": return "Managing files";
    case "tar": case "unzip": case "gzip": case "zip": return "Packing or unpacking files";
    case "jq": return "Reading JSON";
    case "sqlite3": case "psql": return "Querying a database";
    case "docker": return "Working with Docker";
    case "fly": case "flyctl": return "Working with Fly";
    case "chromium": case "chromium-browser": case "google-chrome": case "chrome":
      return args.some((w) => w.startsWith("--screenshot")) ? "Taking a screenshot" : "Opening a headless browser";
    case "make": return "Building the code";
    case "sleep": return "Waiting";
    case "echo": case "printf": return written ? `Writing ${written}` : "Printing a note";
    case "bash": case "sh": case "zsh": {
      const c = words.indexOf("-c");
      if (c >= 0) return describeCommand(words.slice(c + 1).join(" "));
      const f = fileName(rest[0]);
      return f ? `Running ${f}` : "Running a shell script";
    }
    default: return null;
  }
}
