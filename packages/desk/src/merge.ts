/**
 * v1.2 merge rule (architecture.md §4): for a workspace with `merge: "green"`, after a session that ended with a
 * report, find the branch's open PR, run every check in the checkout, and if all pass ready + squash-merge it.
 * Commands go through an injectable runner (tests put a fake `gh` on PATH or inject one).
 */
import { execFile } from "node:child_process";
import type { DeskWorkspace } from "./contract.ts";

export interface CmdResult { code: number; stdout: string; stderr: string }
/** Run `cmd args` in `cwd` (no shell). */
export type CmdRunner = (cmd: string, args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<CmdResult>;

export const realRunner: CmdRunner = (cmd, args, opts) => new Promise((resolve) => {
  execFile(cmd, args, { cwd: opts.cwd, env: process.env, timeout: opts.timeoutMs ?? 20 * 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
    resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
  });
});

export interface MergeResult {
  merged: boolean;
  prNumber: number;
  /** the activity line posted to the town */
  line: string;
  /** which check failed, or the gh error */
  detail?: string;
}

export interface MergeOptions {
  run?: CmdRunner;
  log?: (line: string) => void;
}

const tail = (s: string, n = 300) => s.trim().split("\n").slice(-5).join(" | ").slice(-n);

/**
 * Returns null when no merge was attempted (merge !== green, or the branch has no open PR).
 * Checks run through `sh -c` (they are shell command lines from the building's config, e.g. "npm test").
 */
export async function greenMerge(ws: DeskWorkspace, opts: MergeOptions = {}): Promise<MergeResult | null> {
  if (ws.merge !== "green") return null;
  const run = opts.run ?? realRunner;
  const log = opts.log ?? (() => undefined);
  const cwd = ws.dir;

  const view = await run("gh", ["pr", "view", ws.branch, "--json", "number,isDraft,state"], { cwd, timeoutMs: 60_000 });
  if (view.code !== 0) {
    log(`merge: no PR for ${ws.branch} (${tail(view.stderr, 120) || `gh exited ${view.code}`})`);
    return null;
  }
  let pr: { number?: number; isDraft?: boolean; state?: string };
  try { pr = JSON.parse(view.stdout); } catch { log("merge: unreadable gh pr view output"); return null; }
  if (!pr.number || String(pr.state).toUpperCase() !== "OPEN") {
    log(`merge: PR for ${ws.branch} is not open (${pr.state ?? "?"})`);
    return null;
  }
  const n = pr.number;

  for (const check of ws.checks ?? []) {
    log(`merge: check \`${check}\``);
    const r = await run("sh", ["-c", check], { cwd });
    if (r.code !== 0) {
      log(`merge: check failed (${r.code}): ${tail(r.stderr || r.stdout)}`);
      return { merged: false, prNumber: n, line: "Checks failed, PR left open", detail: `${check} exited ${r.code}` };
    }
  }

  if (pr.isDraft) {
    const ready = await run("gh", ["pr", "ready", String(n)], { cwd, timeoutMs: 60_000 });
    if (ready.code !== 0) return { merged: false, prNumber: n, line: `Merge failed, PR #${n} left open`, detail: `gh pr ready: ${tail(ready.stderr)}` };
  }
  const merge = await run("gh", ["pr", "merge", String(n), "--squash", "--delete-branch"], { cwd, timeoutMs: 120_000 });
  if (merge.code !== 0) return { merged: false, prNumber: n, line: `Merge failed, PR #${n} left open`, detail: `gh pr merge: ${tail(merge.stderr)}` };
  log(`merge: merged PR #${n}`);
  return { merged: true, prNumber: n, line: `Merged PR #${n} (checks green)` };
}
