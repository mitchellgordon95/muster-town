/**
 * The manager's read-only view of the town's code (agent teams step 3, article dc_i7ji4xacd9): a snapshot of main
 * (`git archive`, tracked files only: no .git, node_modules or data) in its own directory. Before a manage session (in-tray
 * or 1:1) the source fetches origin's main into a private ref (at most every `everyMs`, never while a redeploy holds the
 * checkout) and re-extracts when it moved; a failed fetch keeps the last snapshot, or the live HEAD at first. The session
 * gets Read, Grep and Glob over it, cwd there, and a PreToolUse guard that denies any path outside it. No tool that edits
 * or runs: no Bash, Write, Edit, NotebookEdit, Task or Agent.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { HookCallbackMatcher, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { realCommandRunner, type CommandRunner } from "./redeploy.ts";

/** The only built-in tools a code-reading session gets: they read files, none edits or runs anything. */
export const CODE_TOOLS = ["Read", "Grep", "Glob"] as const;

/** The private ref main is fetched into: the shared checkout's own branches and origin/* are left alone. */
const CODE_REF = "refs/muster-town/code-main";

export interface CodeCheckout {
  /** absolute, real path of the snapshot */
  dir: string;
  /** the commit it holds */
  commit: string;
}

const markerOf = (dir: string) => `${dir}.commit`;

/**
 * Make `dir` hold `commit` of `repoRoot` (a no-op when its marker already names it). The new snapshot is extracted next to
 * it and swapped in, so a session reading the old one never sees a half-written tree. Null (logged) when the extract fails.
 */
export async function extractCheckout(repoRoot: string, dir: string, commit: string, run: CommandRunner = realCommandRunner): Promise<CodeCheckout | null> {
  dir = resolve(dir);
  try {
    if (existsSync(dir) && existsSync(markerOf(dir)) && readFileSync(markerOf(dir), "utf8").trim() === commit) return { dir: realpathSync(dir), commit };
    mkdirSync(dirname(dir), { recursive: true });
    const tmp = `${dir}.new`, tar = `${dir}.tar`, old = `${dir}.old`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp);
    const a = await run("git", ["archive", "--format=tar", "-o", tar, commit], { cwd: repoRoot, timeoutMs: 60_000 });
    if (a.code !== 0) throw new Error(`git archive ${commit.slice(0, 7)}: ${a.stderr.trim()}`);
    const x = await run("tar", ["-xf", tar, "-C", tmp], { cwd: repoRoot, timeoutMs: 60_000 });
    rmSync(tar, { force: true });
    if (x.code !== 0) throw new Error(`tar: ${x.stderr.trim()}`);
    rmSync(old, { recursive: true, force: true });
    if (existsSync(dir)) renameSync(dir, old);
    renameSync(tmp, dir);
    rmSync(old, { recursive: true, force: true });
    writeFileSync(markerOf(dir), commit + "\n");
    return { dir: realpathSync(dir), commit };
  } catch (e) {
    console.log("[runtime] code checkout:", e instanceof Error ? e.message : e);
    return null;
  }
}

interface CodeSourceOptions {
  run?: CommandRunner;
  /** the collective's repo token as git env (private repos); never logged */
  gitEnv?: () => Record<string, string>;
  /** the branch to read (default main) */
  branch?: string;
  /** least time between fetches (default 5 min) */
  everyMs?: number;
  now?: () => number;
}

export interface CodeSource {
  /** the snapshot sessions read now (null until the first refresh, or when there is no git checkout) */
  current(): CodeCheckout | null;
  /** fetch main when the last fetch is older than `everyMs`, re-extract when it moved; the snapshot to read (cheap in between: the runtime tick calls it) */
  fresh(): Promise<CodeCheckout | null>;
}

/** The snapshot of main under `dir`, kept fresh from `repoRoot`'s origin. Calls overlap safely: one refresh runs at a time. */
export function codeSource(repoRoot: string, dir: string, o: CodeSourceOptions = {}): CodeSource {
  const run = o.run ?? realCommandRunner, now = o.now ?? Date.now, everyMs = o.everyMs ?? 5 * 60_000, branch = o.branch ?? "main";
  let cur: CodeCheckout | null = null, fetchedAt = -Infinity, tried = false, flight: Promise<CodeCheckout | null> | null = null;
  const sha = async (ref: string) => { const r = await run("git", ["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd: repoRoot, timeoutMs: 10_000 }); return r.code === 0 ? r.stdout.trim() || null : null; };
  // a redeploy pulling in the same checkout holds this lock (redeploy.ts withRepoLock): don't race its git
  const redeploying = () => existsSync(join(repoRoot, ".muster-town-redeploy.lock"));
  async function refresh(): Promise<CodeCheckout | null> {
    const due = now() - fetchedAt >= everyMs && !redeploying();
    if (!due && (cur || tried)) return cur;
    tried = true;
    if (due) {
      fetchedAt = now();
      const f = await run("git", ["fetch", "-q", "--no-tags", "origin", `+refs/heads/${branch}:${CODE_REF}`], { cwd: repoRoot, timeoutMs: 60_000, env: o.gitEnv?.() ?? {} });
      if (f.code !== 0) console.log(`[runtime] code checkout: git fetch ${branch} failed (exit ${f.code}); reading ${cur ? "the last snapshot" : "the live commit"}`);
    }
    const commit = (await sha(CODE_REF)) ?? (cur ? null : await sha("HEAD"));
    if (!commit || commit === cur?.commit) return cur;
    return (cur = (await extractCheckout(repoRoot, dir, commit, run)) ?? cur);
  }
  return {
    current: () => cur,
    fresh: () => (flight ??= refresh().finally(() => { flight = null; })),
  };
}

/** Whether `p` (absolute, or relative to `dir`) resolves inside `dir`, following symlinks as far as they exist. */
function insideCheckout(dir: string, p: string): boolean {
  let abs = isAbsolute(p) ? p : resolve(dir, p);
  // the deepest existing ancestor's real path, so a symlink inside the snapshot can't point out of it
  let tail = "";
  while (!existsSync(abs)) {
    const up = dirname(abs);
    if (up === abs) break;
    tail = tail ? join(abs.slice(up.length + 1), tail) : abs.slice(up.length + 1);
    abs = up;
  }
  let real: string;
  try { real = join(realpathSync(abs), tail); } catch { return false; }
  const rel = relative(dir, real);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const deny = (reason: string): HookJSONOutput => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

/** The path a code tool call reads, from its input (Read file_path, Grep and Glob path; absent = the cwd). */
const pathOf = (input: unknown): string | undefined => {
  const i = (input ?? {}) as Record<string, unknown>;
  const p = i.file_path ?? i.path;
  return typeof p === "string" && p.trim() ? p : undefined;
};

/** The decision for one tool call: town (MCP) tools and the web pass; code tools only inside `dir`; any other built-in is denied. */
export function codeDecision(dir: string, tool: string, input: unknown): HookJSONOutput {
  if (tool.startsWith("mcp__") || tool === "WebSearch" || tool === "WebFetch") return {};
  if (!(CODE_TOOLS as readonly string[]).includes(tool)) return deny(`${tool} is not available here: this session reads the code only (Read, Grep, Glob).`);
  const p = pathOf(input);
  if (p && !insideCheckout(dir, p)) return deny(`Only the town's code checkout (${dir}) can be read here; ${p} is outside it.`);
  return {};
}

/** The PreToolUse hook that enforces `codeDecision` (hooks run even for tools in allowedTools). */
export function codeGuard(dir: string): HookCallbackMatcher[] {
  return [{
    hooks: [async (input) => (input.hook_event_name === "PreToolUse" ? codeDecision(dir, input.tool_name, input.tool_input) : {})],
  }];
}

/** The system prompt line that tells a manage session what it can read. */
export function codeBlock(code: CodeCheckout): string {
  return `## The town's code\nYou can read the Muster Town code with Read, Grep and Glob: a read-only snapshot of main at ${code.commit.slice(0, 7)} (fetched at most a few minutes before this session; it may be ahead of the live server, whose commit GET /api/health gives), your working directory ${code.dir}. You cannot edit or run anything. When asked how something works or why it happened, read the code first and cite file:line instead of guessing.`;
}
