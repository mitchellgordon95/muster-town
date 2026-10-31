/**
 * Keep a dead session's work: while the session runs, its uncommitted changes are pushed every few minutes to
 * `refs/wip/<branch>` on origin, so a desk that freezes or is lost (dc_y06ztrv3a8) doesn't take them with it.
 * The snapshot is a commit on top of HEAD built in a scratch index (tracked and untracked files, .gitignore respected);
 * the branch, the real index and the working tree are never touched. Recover with
 * `git fetch origin refs/wip/<branch> && git checkout FETCH_HEAD -- .` (docs/architecture.md).
 */
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const WIP_PUSH_MS = 10 * 60_000;

export const wipRef = (branch: string) => `refs/wip/${branch}`;

/**
 * Push the working tree's uncommitted changes to refs/wip/<branch>. Returns the pushed commit, or null when there was
 * nothing new (clean tree, or the same tree as the last push). Throws on git errors; callers treat it as best effort.
 */
export async function pushWip(dir: string, branch: string, last: { tree?: string } = {}, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const git = async (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    (await exec("git", args, { cwd: dir, encoding: "utf8", env: { ...env, GIT_TERMINAL_PROMPT: "0", ...extra }, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  if (!(await git(["status", "--porcelain"]))) return null;
  const realIndex = await git(["rev-parse", "--git-path", "index"]);
  const index = join(tmpdir(), `wip-index-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    const src = isAbsolute(realIndex) ? realIndex : join(dir, realIndex);
    if (existsSync(src)) copyFileSync(src, index);
    await git(["add", "-A"], { GIT_INDEX_FILE: index });
    const tree = await git(["write-tree"], { GIT_INDEX_FILE: index });
    if (tree === last.tree) return null;
    const commit = await git(["-c", "user.name=desk", "-c", "user.email=desk@muster-town.local", "commit-tree", tree, "-p", "HEAD", "-m", `wip ${branch} ${new Date().toISOString()}`]);
    // each snapshot sits on the current HEAD, not on the last snapshot: replace the ref (only ever this one ref)
    await git(["push", "--quiet", "--no-verify", "origin", `+${commit}:${wipRef(branch)}`]);
    last.tree = tree;
    return commit;
  } finally {
    rmSync(index, { force: true });
  }
}

/** Every `everyMs`, push the work in `dir` to refs/wip/<branch>; never overlaps itself. Returns the stop function. */
export function startWipPusher(dir: string, branch: string, opts: { everyMs?: number; log?: (line: string) => void; env?: NodeJS.ProcessEnv } = {}): () => void {
  const log = opts.log ?? (() => undefined);
  const last: { tree?: string } = {};
  let busy = false;
  let warned = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const sha = await pushWip(dir, branch, last, opts.env);
      if (sha) log(`work in progress pushed to ${wipRef(branch)} (${sha.slice(0, 7)})`);
    } catch (e) {
      if (!warned) { warned = true; log(`wip push failed (continuing): ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`); }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.everyMs ?? WIP_PUSH_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
