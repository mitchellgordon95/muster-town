/**
 * Contract step 5: make the building's repo ready in the desk's home volume.
 * clone if absent → fetch → check out the session branch (existing local or remote branch, else fresh
 * from origin/<base>) → npm install when package.json exists without node_modules. No shell strings.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeskWorkspace } from "./contract.ts";

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

const errText = (e: unknown) => {
  const x = e as { stderr?: string | Buffer; message?: string };
  const s = x.stderr ? String(x.stderr).trim() : "";
  return s || x.message || String(e);
};

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
    // anything genuinely uncommitted from an earlier session is stashed (recoverable with `git stash list`), not lost
    const dirty = tryRun("git", ["status", "--porcelain"], dir);
    if (dirty && dirty.trim()) {
      run("git", ["stash", "push", "--include-untracked", "-m", `auto-stash before ${branch} ${new Date().toISOString()}`], dir);
      log(`stashed uncommitted changes before switching to ${branch}`);
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

  if (opts.agentName && !tryRun("git", ["config", "user.email"], dir)) {
    const slug = opts.agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
    tryRun("git", ["config", "user.name", opts.agentName], dir);
    tryRun("git", ["config", "user.email", `${slug}@muster-town.local`], dir);
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
