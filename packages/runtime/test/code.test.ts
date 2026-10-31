import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { intrayOf } from "@muster-town/core";
import { CODE_TOOLS, codeDecision, codeSource, extractCheckout } from "../src/code.ts";
import { townOptions, type Ctx } from "../src/session.ts";
import { callVerb, init, result, setup } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

/** A one-commit git repo with src/a.ts; returns its root. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "code-repo-"));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "one");
  return root;
}

/** Tools that edit files or run anything: none may reach a code-reading session. */
const WRITE_OR_RUN = ["Bash", "BashOutput", "KillShell", "Write", "Edit", "MultiEdit", "NotebookEdit", "Task", "Agent"];

describe("the manager's read-only code checkout", () => {
  test("a snapshot of origin's main (tracked files, no .git), fetched again only every everyMs; no origin = the live HEAD", async () => {
    const origin = repo();
    const root = mkdtempSync(join(tmpdir(), "code-clone-"));
    git(root, "clone", "-q", origin, ".");
    const dir = join(mkdtempSync(join(tmpdir(), "code-out-")), "code-main");
    let t = 0;
    const src = codeSource(root, dir, { now: () => t, everyMs: 1000 });
    expect(src.current()).toBeNull();
    const one = (await src.fresh())!;
    expect(one.commit).toBe(git(origin, "rev-parse", "HEAD"));
    expect(src.current()).toEqual(one);
    expect(readFileSync(join(one.dir, "src", "a.ts"), "utf8")).toContain("a = 1");
    expect(existsSync(join(one.dir, ".git"))).toBe(false);

    // main moves on origin (a merged PR): the clone's own HEAD stays, the snapshot follows main once the interval passed
    writeFileSync(join(origin, "src", "a.ts"), "export const a = 2;\n");
    git(origin, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "two");
    t = 500;
    expect(await src.fresh()).toEqual(one); // not due yet
    t = 1500;
    const two = (await src.fresh())!;
    expect(two.commit).toBe(git(origin, "rev-parse", "HEAD"));
    expect(two.commit).not.toBe(git(root, "rev-parse", "HEAD"));
    expect(two.dir).toBe(one.dir);
    expect(readFileSync(join(two.dir, "src", "a.ts"), "utf8")).toContain("a = 2");
    expect(await extractCheckout(root, dir, two.commit)).toEqual(two); // same commit: left alone

    // a redeploy holds the checkout: no fetch
    writeFileSync(join(origin, "src", "a.ts"), "export const a = 3;\n");
    git(origin, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "three");
    writeFileSync(join(root, ".muster-town-redeploy.lock"), "");
    t = 3000;
    expect((await src.fresh())!.commit).toBe(two.commit);

    // no origin: the live HEAD; not a git checkout: nothing
    const solo = repo();
    expect((await codeSource(solo, join(mkdtempSync(join(tmpdir(), "code-out-")), "code-main")).fresh())!.commit).toBe(git(solo, "rev-parse", "HEAD"));
    expect(await codeSource(mkdtempSync(join(tmpdir(), "not-git-")), join(mkdtempSync(join(tmpdir(), "code-out-")), "code-main")).fresh()).toBeNull();
  });

  test("the guard: Read, Grep and Glob inside the checkout only; every tool that edits or runs is denied", async () => {
    const root = repo();
    const { dir } = (await extractCheckout(root, join(mkdtempSync(join(tmpdir(), "code-out-")), "code-main"), git(root, "rev-parse", "HEAD")))!;
    symlinkSync("/etc", join(dir, "escape"));
    const denied = (tool: string, input: unknown) => (codeDecision(dir, tool, input) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === "deny";
    expect(denied("Read", { file_path: join(dir, "src", "a.ts") })).toBe(false);
    expect(denied("Read", { file_path: "src/a.ts" })).toBe(false);
    expect(denied("Grep", { pattern: "a" })).toBe(false); // no path = the cwd, the checkout
    expect(denied("Glob", { pattern: "**/*.ts", path: join(dir, "src") })).toBe(false);
    expect(denied("Read", { file_path: "/etc/passwd" })).toBe(true);
    expect(denied("Read", { file_path: join(dir, "..", "code-main.commit") })).toBe(true);
    expect(denied("Grep", { pattern: "x", path: "../" })).toBe(true);
    expect(denied("Read", { file_path: join(dir, "escape", "passwd") })).toBe(true); // a symlink out of it
    expect(denied("Glob", { pattern: "*", path: join(dir, "escape") })).toBe(true);
    for (const t of WRITE_OR_RUN) expect(denied(t, { command: "ls", file_path: join(dir, "src", "a.ts") })).toBe(true);
    expect(denied("mcp__town__look", {})).toBe(false);
  });

  test("a code-reading session's tools: Read, Grep, Glob and nothing that edits or runs; cwd is the checkout", () => {
    const code = { dir: "/srv/code-main", commit: "abc1234" };
    const ctx = { world: { tokens: { getOrCreate: () => "tok" } }, mcpUrl: "http://x/mcp", env: {} } as unknown as Ctx;
    const spec = { agentId: "ag_x", purpose: "manage" as const, model: "claude-opus-5-5", system: "", prompt: "", maxTurns: 5, web: false };
    const credential = { kind: "subscription" as const, secret: "t", inputId: null };
    const o = townOptions(ctx, { ...spec, code }, credential);
    expect(o.tools).toEqual([...CODE_TOOLS]);
    for (const t of WRITE_OR_RUN) {
      expect(o.tools).not.toContain(t);
      expect(o.allowedTools).not.toContain(t);
    }
    for (const t of ["Bash", "Write", "Edit", "Task", "Agent"]) expect(o.disallowedTools).toContain(t);
    for (const t of CODE_TOOLS) expect(o.disallowedTools).not.toContain(t);
    expect(o.cwd).toBe(code.dir);
    expect(o.hooks?.PreToolUse).toHaveLength(1);
    // without a checkout: no built-in tools at all, as before
    const plain = townOptions(ctx, spec, credential);
    expect(plain.tools).toEqual([]);
    expect(plain.cwd).toBeUndefined();
    expect(plain.hooks).toBeUndefined();
  });

  test("a runtime with codeDir gives the manager's manage session the code tools and says so in its prompt", async () => {
    const root = repo();
    const env = setup(async function* (s) {
      yield init();
      yield* callVerb(s, "look", {});
      yield result(100, 0.01, "Nothing to decide.");
    }, { repoRoot: root, codeDir: join(mkdtempSync(join(tmpdir(), "code-out-")), "code-main") });
    const { world, runtime, sdk, by, lab } = env;
    await runtime.whenIdle(); // the first snapshot (no origin here: the repo's HEAD)
    const admin = world.ops.ensureAvatar(env.seed.admin.id);
    for (const d of intrayOf(world, lab.id)) await world.verbs.review(admin.id, { docId: d.id, decision: "approve" });
    world.buildings.patch(lab.id, { blockedAt: new Date().toISOString() });
    world.ops.updateBuilding(admin, lab.id, { managerAgentId: by("Mei").id });
    await world.verbs.submit_report(by("Noor").id, { title: "Growth", verdict: "stop", body: "## What I did\nX.\n\n## Findings\nY.\n\n## What I need from you\nNothing needed." });
    await runtime.whenIdle();
    const s = sdk.sessions.find((x) => x.agentId === by("Mei").id)!;
    expect(s.options.tools).toEqual([...CODE_TOOLS]);
    expect(s.options.cwd).toMatch(/code-main$/);
    expect(s.options.systemPrompt).toMatchObject({ append: expect.stringContaining("## The town's code") });
  });
});
