/**
 * Contract step 5: make the building's repo ready in the desk's home volume.
 * clone if absent → fetch → check out the session branch (existing local or remote branch, else fresh
 * from origin/<base>) → npm install when package.json exists without node_modules. No shell strings.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DeskWorkspace } from "@muster-town/schema";

export interface WorkspaceOptions {
  /** when set, `gh auth setup-git` runs so git pushes authenticate with GH_TOKEN */
  ghToken?: string;
  /** used for a repo-local git identity when none is configured */
  agentName?: string;
  /** skip `npm install` (tests) */
  npmInstall?: boolean;
  log?: (line: string) => void;
}

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env }).trim();
}

function tryRun(cmd: string, args: string[], cwd?: string): string | null {
  try {
    return run(cmd, args, cwd);
  } catch {
    return null;
  }
}

/** stderr, else stdout (git prints "needs merge" on stdout), else the message. */
const errText = (e: unknown) => {
  const x = e as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
  const s = x.stderr ? String(x.stderr).trim() : "";
  const o = x.stdout ? String(x.stdout).trim() : "";
  return s || (o && x.message ? `${x.message.split("\n")[0]}: ${o}` : o) || x.message || String(e);
};

/**
 * `git stash` refused the dirty tree (seen live: a merge left half-done with conflicted files, "needs merge"). Copy every
 * changed and untracked file plus a patch and the status into `<parent>/.workspace-backups/<repo>-<stamp>/`, then leave
 * any merge/rebase/cherry-pick/revert and reset the tree to HEAD so setup can go on. Returns the backup dir.
 */
function moveDirtyTreeAside(dir: string, stashError: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(dirname(dir), ".workspace-backups", `${basename(dir)}-${stamp}`);
  mkdirSync(join(backup, "files"), { recursive: true });
  const head = tryRun("git", ["rev-parse", "HEAD"], dir) ?? "?";
  const branch = tryRun("git", ["branch", "--show-current"], dir) ?? "?";
  const status = tryRun("git", ["status", "--porcelain"], dir) ?? "";
  writeFileSync(join(backup, "README.txt"),
    `Moved aside by desk workspace setup: git stash failed.\n${stashError}\n\nbranch ${branch}\nHEAD ${head}\n\n${status}\n`);
  const patch = tryRun("git", ["diff", "HEAD", "--binary"], dir);
  if (patch) writeFileSync(join(backup, "changes.patch"), `${patch}\n`);
  const listed = tryRun("git", ["ls-files", "-z", "--modified", "--others", "--exclude-standard"], dir) ?? "";
  for (const rel of new Set(listed.split("\0").filter(Boolean))) {
    const from = join(dir, rel);
    if (existsSync(from)) cpSync(from, join(backup, "files", rel), { recursive: true });
  }
  for (const op of ["merge", "rebase", "cherry-pick", "revert"]) tryRun("git", [op, "--quit"], dir);
  run("git", ["reset", "--hard", "HEAD"], dir);
  run("git", ["clean", "-fd"], dir);
  return backup;
}

/** Prepare the workspace and return the session cwd (`ws.dir`). Throws when clone/fetch/checkout fail. */
export function setupWorkspace(ws: DeskWorkspace, opts: WorkspaceOptions = {}): string {
  const log = opts.log ?? (() => undefined);
  const { dir, base, branch } = ws;

  if (opts.ghToken) {
    try {
      run("gh", ["auth", "setup-git"]);
      log("gh auth setup-git ok");
    } catch (e) {
      log(`gh auth setup-git failed (continuing): ${errText(e).split("\n")[0]}`);
    }
  }

  try {
    if (!existsSync(join(dir, ".git"))) {
      mkdirSync(dirname(dir), { recursive: true });
      log(`cloning into ${dir}`);
      run("git", ["clone", ws.repoUrl, dir]);
    }
    run("git", ["fetch", "origin", "--prune"], dir);
    // npm install inside the desk flips the exec bit on `bin` files; never let a mode change block a checkout
    run("git", ["config", "core.fileMode", "false"], dir);
    // stash needs an identity too, so set the repo-local one before it
    if (opts.agentName && !tryRun("git", ["config", "user.email"], dir)) {
      const slug = opts.agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
      tryRun("git", ["config", "user.name", opts.agentName], dir);
      tryRun("git", ["config", "user.email", `${slug}@muster-town.local`], dir);
    }
    // anything genuinely uncommitted from an earlier session is stashed (recoverable with `git stash list`), not lost
    const dirty = tryRun("git", ["status", "--porcelain"], dir);
    if (dirty && dirty.trim()) {
      try {
        run("git", ["stash", "push", "--include-untracked", "-m", `auto-stash before ${branch} ${new Date().toISOString()}`], dir);
        log(`stashed uncommitted changes before switching to ${branch}`);
      } catch (e) {
        const why = errText(e).split("\n").slice(0, 3).join(" | ");
        const backup = moveDirtyTreeAside(dir, why);
        log(`git stash failed (${why}); moved the uncommitted tree aside to ${backup} and reset to HEAD`);
      }
    }

    const hasLocal = tryRun("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], dir) !== null;
    const hasRemote = tryRun("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], dir) !== null;
    if (hasLocal) {
      run("git", ["checkout", branch], dir);
      log(`checked out existing branch ${branch}`);
    } else if (hasRemote) {
      run("git", ["checkout", "-B", branch, `origin/${branch}`], dir);
      log(`checked out ${branch} from origin/${branch}`);
    } else {
      run("git", ["checkout", "-B", branch, `origin/${base}`], dir);
      log(`created branch ${branch} from origin/${base}`);
    }
  } catch (e) {
    const text = errText(e);
    // git asked a terminal for a username: the repo needs credentials and the desk has none (or they were refused)
    const hint = /could not read Username|Authentication failed|Permission denied/i.test(text)
      ? opts.ghToken
        ? " (the desk's GH_TOKEN was refused: it needs read access to this repo)"
        : " (the desk has no GH_TOKEN, so a private repo can't be cloned: set `desks.ghToken` and the host's GH_TOKEN or `gh auth login`)"
      : "";
    throw new Error(`workspace setup failed${hint}: ${text}`);
  }

  if (opts.npmInstall !== false && existsSync(join(dir, "package.json")) && !existsSync(join(dir, "node_modules"))) {
    log("npm install");
    try {
      run("npm", ["install", "--no-audit", "--no-fund"], dir);
    } catch (e) {
      log(`npm install failed (continuing): ${errText(e).split("\n").slice(-1)[0]}`);
    }
  }
  return dir;
}
