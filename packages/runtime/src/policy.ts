/**
 * Permission policy for workshop sessions. Claude Code asks `canUseTool` for every tool call that no
 * allow rule covers; without an answer the session hangs. This answers automatically:
 * file tools must stay inside the agent's worktree, shell commands may only run approved programs
 * (every segment of a compound command is checked), and a few git operations are always denied.
 */
import { isAbsolute, resolve, sep } from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

export interface PolicyOpts {
  cwd: string;
  base: string;
  /** workspace tool patterns: "Edit", "Bash(git:*)", ... */
  tools: string[];
}

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "NotebookEdit", "LS"]);
const ALWAYS_OK_PROGRAMS = new Set(["cd", "echo", "pwd", "true", "false", "test", "[", "printf", "export", "env", "which", "type", "diff", "sort", "uniq", "cut", "tr", "xargs", "jq", "awk", "date", "sleep", "tee", "touch", "cp", "mv"]);
const DENY_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, "recursive force delete"],
  [/\bgit\s+push\b[^;&|]*(\s-f\b|\s--force\b|\s--force-with-lease\b|\s\+\S)/, "force push"],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|branch\s+-D|worktree\s+(remove|prune)|filter-branch|rebase)\b/, "history-rewriting git command"],
  [/\bsudo\b/, "sudo"],
  [/\b(curl|wget)\b[^;&|]*\|\s*(sh|bash|zsh|node)\b/, "piping a download into a shell"],
  [/\bgh\s+pr\s+merge\b/, "merging a PR"],
  [/\bgh\s+repo\s+(delete|edit)\b/, "repo settings change"],
];

export function parseTools(tools: string[]): { names: Set<string>; programs: Set<string> } {
  const names = new Set<string>();
  const programs = new Set<string>();
  for (const t of tools) {
    const m = /^(\w+)\((.*)\)$/.exec(t);
    if (!m) { names.add(t); continue; }
    names.add(m[1]);
    if (m[1] === "Bash") { const prog = m[2].split(":")[0].trim(); if (prog && prog !== "*") programs.add(prog); }
  }
  return { names, programs };
}

function inside(cwd: string, p: string): boolean {
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  return abs === cwd || abs.startsWith(cwd + sep);
}

/** Split a shell command into segments on ; && || | and newlines (quotes are not parsed; be conservative). */
export function segments(cmd: string): string[] {
  return cmd.split(/\n|;|&&|\|\||\|/).map((s) => s.trim().replace(/^[({]+\s*/, "").replace(/\s*[)}]+$/, "")).filter(Boolean);
}

function firstProgram(segment: string): string {
  const words = segment.split(/\s+/);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++; // env assignments
  return (words[i] ?? "").replace(/^.*\//, ""); // strip a path prefix
}

export function decideBash(o: PolicyOpts, programs: Set<string>, command: string): PermissionResult {
  for (const [re, why] of DENY_PATTERNS) if (re.test(command)) return deny(`Denied (${why}). Keep to your branch and your worktree.`);
  const pushToBase = new RegExp(`\\bgit\\s+push\\b[^;&|]*\\b(${o.base}|main|master)\\b(?!\\S*/)`);
  if (pushToBase.test(command) && !/\bgit\s+push\s+(-u\s+)?origin\s+agent\//.test(command)) return deny(`Denied: never push to ${o.base}. Push your own branch (git push -u origin <your-branch>).`);
  for (const seg of segments(command)) {
    const prog = firstProgram(seg);
    if (!prog) continue;
    if (prog === "cd") {
      const target = seg.split(/\s+/)[1] ?? "";
      if (target && target !== "-" && !inside(o.cwd, target.replace(/^["']|["']$/g, ""))) return deny(`Denied: cd outside your worktree (${o.cwd}).`);
      continue;
    }
    if (ALWAYS_OK_PROGRAMS.has(prog) || programs.has(prog)) continue;
    return deny(`Denied: \`${prog}\` is not an allowed program here. Allowed: ${[...programs].sort().join(", ")} (plus cd/echo/pwd and basic text utilities). Stay inside ${o.cwd}.`);
  }
  return { behavior: "allow" };
}

export function workspacePolicy(o: PolicyOpts): CanUseTool {
  const cwd = resolve(o.cwd);
  const { names, programs } = parseTools(o.tools);
  return async (toolName, input) => {
    if (toolName.startsWith("mcp__town__") || toolName === "WebSearch" || toolName === "WebFetch") return { behavior: "allow" };
    if (!names.has(toolName)) return deny(`Denied: ${toolName} is not available in this building.`);
    if (toolName === "Bash") return decideBash({ ...o, cwd }, programs, String(input.command ?? ""));
    if (FILE_TOOLS.has(toolName)) {
      const p = [input.file_path, input.path, input.notebook_path].find((v) => typeof v === "string") as string | undefined;
      if (p && !inside(cwd, p)) return deny(`Denied: ${toolName} outside your worktree (${cwd}). Only edit files under it.`);
      return { behavior: "allow" };
    }
    return deny(`Denied: ${toolName} is not allowed here.`);
  };
}

function deny(message: string): PermissionResult { return { behavior: "deny", message }; }
