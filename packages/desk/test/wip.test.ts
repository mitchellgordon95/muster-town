import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pushWip } from "../src/wip.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env }).trim();
const ident = ["-c", "user.name=T", "-c", "user.email=t@t"];

let root: string;
let bare: string;
let dir: string;
const savedEnv = { ...process.env };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "desk-wip-"));
  writeFileSync(join(root, "gitconfig"), "");
  process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  bare = join(root, "origin.git");
  git(root, "init", "--bare", "-b", "main", bare);
  dir = join(root, "work");
  git(root, "clone", bare, dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  git(dir, "add", ".");
  git(dir, ...ident, "commit", "-m", "init");
  git(dir, "push", "origin", "HEAD:main");
  git(dir, "checkout", "-b", "agent/ada/x");
});
afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(root, { recursive: true, force: true });
});

describe("pushWip", () => {
  it("pushes tracked and untracked changes to refs/wip/<branch> without touching the branch, index or tree", async () => {
    const head = git(dir, "rev-parse", "HEAD");
    expect(await pushWip(dir, "agent/ada/x")).toBeNull(); // clean: nothing to push

    writeFileSync(join(dir, "README.md"), "hello\nedited\n");
    writeFileSync(join(dir, "new.ts"), "export {}\n");
    git(dir, "add", "README.md"); // one change staged, one not: the real index must stay as it is
    const statusBefore = git(dir, "status", "--porcelain");
    const last: { tree?: string } = {};
    const sha = await pushWip(dir, "agent/ada/x", last);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(bare, "rev-parse", "refs/wip/agent/ada/x")).toBe(sha);
    expect(git(bare, "rev-parse", `${sha}^`)).toBe(head);
    expect(git(bare, "show", `${sha}:new.ts`)).toBe("export {}");
    expect(git(bare, "show", `${sha}:README.md`)).toBe("hello\nedited");
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "status", "--porcelain")).toBe(statusBefore);
    expect(() => git(bare, "rev-parse", "--verify", "refs/heads/agent/ada/x")).toThrow();

    expect(await pushWip(dir, "agent/ada/x", last)).toBeNull(); // same tree: no second push

    // a later snapshot replaces the ref; recovery as docs/architecture.md says
    writeFileSync(join(dir, "new.ts"), "export const a = 1\n");
    const sha2 = await pushWip(dir, "agent/ada/x", last);
    expect(git(bare, "rev-parse", "refs/wip/agent/ada/x")).toBe(sha2);
    const other = join(root, "other");
    git(root, "clone", bare, other);
    git(other, "checkout", "-b", "agent/ada/x", "origin/main");
    git(other, "fetch", "origin", "refs/wip/agent/ada/x");
    git(other, "checkout", "FETCH_HEAD", "--", ".");
    expect(git(other, "show", ":new.ts")).toBe("export const a = 1");
  });
});
