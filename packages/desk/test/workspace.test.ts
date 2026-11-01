import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupWorkspace } from "../src/workspace.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env }).trim();
const ident = ["-c", "user.name=T", "-c", "user.email=t@t"];

let root: string;
let bare: string;
const savedEnv = { ...process.env };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "desk-ws-"));
  // isolate from the host's git identity/config (the desk image has none)
  writeFileSync(join(root, "gitconfig"), "");
  process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  bare = join(root, "origin.git");
  git(root, "init", "--bare", "-b", "main", bare);
  const seed = join(root, "seed");
  git(root, "clone", bare, seed);
  writeFileSync(join(seed, "README.md"), "hello\n");
  git(seed, "add", ".");
  git(seed, ...ident, "commit", "-m", "init");
  git(seed, "push", "origin", "HEAD:main");
});
afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(root, { recursive: true, force: true });
});

describe("setupWorkspace", () => {
  it("clones, branches from origin/base, and reuses the branch on re-run", () => {
    const dir = join(root, "home", "work", "origin");
    const ws = { repoUrl: bare, base: "main", branch: "agent/ada/co2", branchPrefix: "agent", dir };
    const logs: string[] = [];
    expect(setupWorkspace(ws, { agentName: "Ada Lovelace", npmInstall: false, log: (l) => logs.push(l) })).toBe(dir);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect(git(dir, "branch", "--show-current")).toBe("agent/ada/co2");
    expect(git(dir, "rev-parse", "HEAD")).toBe(git(bare, "rev-parse", "main"));
    expect(git(dir, "config", "user.email")).toBe("ada-lovelace@muster-town.local");

    // work on the branch, then a second session must keep it
    writeFileSync(join(dir, "notes.md"), "wip\n");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "wip");
    const wip = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "main");

    setupWorkspace(ws, { npmInstall: false, log: (l) => logs.push(l) });
    expect(git(dir, "branch", "--show-current")).toBe("agent/ada/co2");
    expect(git(dir, "rev-parse", "HEAD")).toBe(wip);
    expect(logs.some((l) => l.includes("checked out existing branch"))).toBe(true);
  });

  it("tracks a branch that exists only on origin (fresh home volume)", () => {
    const seed = join(root, "seed");
    git(seed, "checkout", "-b", "agent/ada/old");
    writeFileSync(join(seed, "old.md"), "old\n");
    git(seed, "add", ".");
    git(seed, ...ident, "commit", "-m", "old work");
    git(seed, "push", "origin", "agent/ada/old");
    const dir = join(root, "fresh");
    setupWorkspace({ repoUrl: bare, base: "main", branch: "agent/ada/old", branchPrefix: "agent", dir }, { npmInstall: false });
    expect(existsSync(join(dir, "old.md"))).toBe(true);
  });

  it("moves a half-done merge aside when git stash refuses it, then checks out the session branch", () => {
    const dir = join(root, "home", "work", "origin");
    const ws = { repoUrl: bare, base: "main", branch: "agent/ada/one", branchPrefix: "agent", dir };
    setupWorkspace(ws, { agentName: "Ada", npmInstall: false });
    // a conflicting merge left unresolved, plus an untracked file: `git stash` answers "needs merge" (on stdout) and fails
    writeFileSync(join(dir, "README.md"), "mine\n");
    git(dir, "commit", "-am", "mine");
    git(dir, "checkout", "-b", "other", "origin/main");
    writeFileSync(join(dir, "README.md"), "theirs\n");
    git(dir, "commit", "-am", "theirs");
    git(dir, "checkout", "agent/ada/one");
    expect(() => git(dir, "merge", "other")).toThrow();
    writeFileSync(join(dir, "scratch.txt"), "keep me\n");

    const logs: string[] = [];
    setupWorkspace({ ...ws, branch: "agent/ada/two" }, { npmInstall: false, log: (l) => logs.push(l) });
    expect(git(dir, "branch", "--show-current")).toBe("agent/ada/two");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(false);
    const line = logs.find((l) => l.startsWith("git stash failed"));
    expect(line).toMatch(/needs merge/);
    const backup = line!.match(/aside to (\S+) and reset/)![1];
    expect(readFileSync(join(backup, "files", "scratch.txt"), "utf8")).toBe("keep me\n");
    expect(readFileSync(join(backup, "files", "README.md"), "utf8")).toMatch(/<<<<<<<|mine|theirs/);
    expect(readFileSync(join(backup, "README.txt"), "utf8")).toMatch(/UU README.md/);
  });

  it("names the missing GH_TOKEN when a private https repo asks for credentials", () => {
    // no terminal to prompt on: git fails the way it does in a desk that got no token
    const prev = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0";
    try {
      expect(() => setupWorkspace({ repoUrl: "https://github.com/muster-town-tests/definitely-private-nope.git", base: "main", branch: "b", branchPrefix: "agent", dir: join(root, "y") }, { npmInstall: false }))
        .toThrow(/workspace setup failed \(the desk has no GH_TOKEN/);
    } finally {
      if (prev === undefined) delete process.env.GIT_TERMINAL_PROMPT; else process.env.GIT_TERMINAL_PROMPT = prev;
    }
  });

  it("throws a readable error for a bad repo", () => {
    expect(() => setupWorkspace({ repoUrl: join(root, "missing.git"), base: "main", branch: "b", branchPrefix: "agent", dir: join(root, "x") }, { npmInstall: false }))
      .toThrow(/workspace setup failed/);
  });
});
