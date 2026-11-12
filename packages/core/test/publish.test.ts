import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLISH_TOKEN_SECRET, REPO_TOKEN_SECRET } from "../src/index.ts";
import { maskTokens, worldSource, writeExport } from "../src/export.ts";
import { freshWorld, tempDir } from "./helpers.ts";

// Publish to GitHub (gr_30f8obzab8): the hourly export pushes its mirror to the World's own repo; a local bare repo over
// file:// stands in for GitHub (the auth header the push carries in its env is harmless there).
const TOKEN = "github_pat_TESTtoken0123456789abcdefSECRET";

function bareRepo(): { dir: string; url: string } {
  const dir = tempDir();
  execFileSync("git", ["init", "-q", "--bare", dir]);
  return { dir, url: `file://${dir}` };
}
const head = (bare: string) => { try { return execFileSync("git", ["rev-parse", "refs/heads/main"], { cwd: bare, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
const show = (bare: string, path: string) => execFileSync("git", ["show", `main:${path}`], { cwd: bare, encoding: "utf8" });
/** every file under `dir` (including .git) that contains `needle` */
function filesWith(dir: string, needle: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (readFileSync(p).includes(needle)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

beforeEach(() => vi.stubEnv("MUSTER_TOWN_DATA_KEY", randomBytes(32).toString("hex")));
afterEach(() => vi.unstubAllEnvs());

describe("publish: the export pushes to the collective's repo", () => {
  it("writeExport pushes HEAD to the remote's main; the token is nowhere in the export dir, .git/config, the result or export.done", () => {
    const { world } = freshWorld();
    const bare = bareRepo();
    const r = writeExport(worldSource(world), tempDir(), { repoUrl: bare.url, token: TOKEN, lastPushCommit: null });
    expect(r.error).toBeNull();
    expect(r.pushError).toBeNull();
    expect(r.pushCommit).toBe(r.commit);
    expect(r.pushedAt).not.toBeNull();
    expect(head(bare.dir)).toBe(r.commit);
    const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    for (const needle of [TOKEN, b64]) {
      expect(filesWith(r.dir, needle)).toEqual([]);
      expect(filesWith(bare.dir, needle)).toEqual([]);
    }
    expect(readFileSync(join(r.dir, ".git", "config"), "utf8")).not.toMatch(/remote|extraheader/);
    world.recordExport(r);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(world.events.list({ types: ["export.done"], limit: 10, desc: true })[0])).not.toContain(TOKEN);
  });

  it("no push when the repo already has HEAD; a stale lastPushCommit (an earlier failed push) catches up with no local change", () => {
    const { world } = freshWorld();
    const bare = bareRepo();
    const dir = tempDir();
    const first = writeExport(worldSource(world), dir, { repoUrl: bare.url, token: null, lastPushCommit: null });
    const again = writeExport(worldSource(world), dir, { repoUrl: bare.url, token: null, lastPushCommit: first.commit });
    expect(again).toMatchObject({ changed: false, pushedAt: null, pushCommit: null, pushError: null });
    const other = bareRepo();
    const catchUp = writeExport(worldSource(world), dir, { repoUrl: other.url, token: null, lastPushCommit: "0".repeat(40) });
    expect(catchUp.changed).toBe(false);
    expect(catchUp.pushCommit).toBe(first.commit);
    expect(head(other.dir)).toBe(first.commit);
  });

  it("a failed push still commits locally; pushError is git's first line with the token masked", () => {
    const { world } = freshWorld();
    const r = writeExport(worldSource(world), tempDir(), { repoUrl: `file://${tempDir()}/missing-${TOKEN}.git`, token: TOKEN, lastPushCommit: null });
    expect(r.error).toBeNull();
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.pushedAt).toBeNull();
    expect(r.pushError).toMatch(/^git (fetch|push): /);
    expect(r.pushError).not.toContain(TOKEN);
    expect(maskTokens(`fatal: ghp_${"a".repeat(36)} bad`)).toBe("fatal: *** bad");
  });
});

/** A hand commit on the bare repo's main (a clone, the files written, committed and pushed back); returns the new head. */
function handCommit(bare: { dir: string; url: string }, files: Record<string, string>, message = "hand commit"): string {
  const work = tempDir();
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=Human", "-c", "user.email=human@example.com", ...args], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  g("init", "-q", "-b", "main");
  if (head(bare.dir)) { g("fetch", "-q", bare.url, "main"); g("reset", "-q", "--hard", "FETCH_HEAD"); }
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(work, path)), { recursive: true }); writeFileSync(join(work, path), content); }
  g("add", "-A");
  g("commit", "-q", "-m", message);
  g("push", "-q", bare.url, "HEAD:refs/heads/main");
  return g("rev-parse", "HEAD");
}
const isAncestor = (bare: string, a: string, b: string) => { try { execFileSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: bare, stdio: "ignore" }); return true; } catch { return false; } };

// Decision 5 of 1:1 mt_msnjkpgwdb: a repo whose main already has commits (GitHub's "initialise with README", a hand commit)
describe("publish: the push survives foreign commits on the repo's main", () => {
  it("a repo made with a README and LICENSE: the export lands on top of that commit, the LICENSE survives, README.md is the export's", () => {
    const { world } = freshWorld();
    const bare = bareRepo();
    const init = handCommit(bare, { "README.md": "# my repo\n", LICENSE: "MIT\n" }, "Initial commit");
    const r = writeExport(worldSource(world), tempDir(), { repoUrl: bare.url, token: TOKEN, lastPushCommit: null });
    expect(r.pushError).toBeNull();
    expect(r.pushCommit).toBe(head(bare.dir));
    expect(r.pushCommit).not.toBe(r.commit); // a new commit on top of the remote's, not the local export commit
    expect(isAncestor(bare.dir, init, r.pushCommit!)).toBe(true); // no force: the initial commit is still in main's history
    expect(show(bare.dir, "LICENSE")).toBe("MIT\n");
    expect(show(bare.dir, "README.md")).toMatch(/The town is the source of truth and this repo is its mirror/);
    expect(JSON.parse(show(bare.dir, "town.json")).name).toBe(world.town.get().name);
    expect(show(bare.dir, "index.json")).toBe(readFileSync(join(r.dir, "index.json"), "utf8"));
    expect(filesWith(bare.dir, TOKEN)).toEqual([]);
  });

  it("a hand commit after a push: the next export pushes again without force and keeps the foreign files", () => {
    const { world } = freshWorld();
    const bare = bareRepo();
    const dir = tempDir();
    const first = writeExport(worldSource(world), dir, { repoUrl: bare.url, token: null, lastPushCommit: null });
    expect(head(bare.dir)).toBe(first.commit); // an empty repo gets the export commit itself
    const hand = handCommit(bare, { ".gitignore": "node_modules\n", ".github/workflows/ci.yml": "on: push\n" });
    world.town.set({ name: "Renamed Town" });
    const next = writeExport(worldSource(world), dir, { repoUrl: bare.url, token: null, lastPushCommit: first.pushCommit });
    expect(next.changed).toBe(true);
    expect(next.pushError).toBeNull();
    expect(head(bare.dir)).toBe(next.pushCommit);
    expect(isAncestor(bare.dir, hand, next.pushCommit!)).toBe(true);
    expect(show(bare.dir, ".gitignore")).toBe("node_modules\n");
    expect(show(bare.dir, ".github/workflows/ci.yml")).toBe("on: push\n");
    expect(JSON.parse(show(bare.dir, "town.json")).name).toBe("Renamed Town");
    // nothing new in the town: the repo already shows this export, so nothing is pushed
    const idle = writeExport(worldSource(world), dir, { repoUrl: bare.url, token: null, lastPushCommit: next.pushCommit });
    expect(idle).toMatchObject({ pushedAt: null, pushCommit: null, pushError: null });
    expect(head(bare.dir)).toBe(next.pushCommit);
    // a third hour with a change still lands on top of the rebuilt commit
    world.town.set({ name: "Third Town" });
    const third = writeExport(worldSource(world), dir, { repoUrl: bare.url, token: null, lastPushCommit: next.pushCommit });
    expect(isAncestor(bare.dir, next.pushCommit!, third.pushCommit!)).toBe(true);
    expect(show(bare.dir, ".gitignore")).toBe("node_modules\n");
  });

  it("a hand edit to an exported file (or a hand file inside the export's folders) is overwritten by the next export", () => {
    const { world } = freshWorld();
    const bare = bareRepo();
    const dir = tempDir();
    const first = writeExport(worldSource(world), dir, { repoUrl: bare.url, token: null, lastPushCommit: null });
    handCommit(bare, { "town.json": "{\"name\":\"hacked\"}\n", "library/stray.md": "hand\n", "NOTES.md": "kept\n" });
    world.town.set({ name: "Changed Town" });
    const next = writeExport(worldSource(world), dir, { repoUrl: bare.url, token: null, lastPushCommit: first.pushCommit });
    expect(next.pushError).toBeNull();
    expect(show(bare.dir, "town.json")).toBe(readFileSync(join(dir, "town.json"), "utf8"));
    expect(JSON.parse(show(bare.dir, "town.json")).name).toBe("Changed Town");
    expect(() => show(bare.dir, "library/stray.md")).toThrow();
    expect(show(bare.dir, "NOTES.md")).toBe("kept\n");
  });
});

describe("publish: the World's setting", () => {
  it("setPublish stores the token as a runtime-owned secret: never listed, granted, settable or deletable via /api/secrets", () => {
    const { world } = freshWorld();
    const resident = world.agents.first("kind = 'resident'");
    const p = world.setPublish({ repoUrl: "https://github.com/acme/town-docs", token: TOKEN });
    expect(p).toEqual({ repoUrl: "https://github.com/acme/town-docs", tokenSet: true, lastPushAt: null, lastPushCommit: null, lastPushError: null, tokenSource: "own" });
    const { tokenSource: _live, ...stored } = p;
    expect(world.town.get().publish).toEqual(stored); // tokenSource is read live, never stored
    expect(world.secrets.value(PUBLISH_TOKEN_SECRET)).toBe(TOKEN);
    expect(world.secrets.list()).toEqual([]);
    expect(world.secrets.get(PUBLISH_TOKEN_SECRET)).toBeNull();
    if (resident) expect(world.secrets.forAgent(resident.id)).toEqual([]);
    expect(() => world.secrets.put(PUBLISH_TOKEN_SECRET, { value: "x", grants: { town: true, buildings: [], agents: [], skills: [] } }, null)).toThrow(/reserved/);
    expect(world.secrets.delete(PUBLISH_TOKEN_SECRET, null)).toEqual({ removed: false });
    // a later save without a token keeps it
    expect(world.setPublish({ repoUrl: "https://github.com/acme/town-docs" }).tokenSet).toBe(true);
    expect(world.secrets.value(PUBLISH_TOKEN_SECRET)).toBe(TOKEN);
    const evs = world.events.list({ types: ["town.publish-set", "town.publish-cleared"], limit: 10 });
    expect(world.clearPublish()).toEqual({ cleared: true });
    expect(world.town.get().publish).toBeUndefined();
    expect(world.secrets.value(PUBLISH_TOKEN_SECRET)).toBeNull();
    expect(JSON.stringify([...evs, ...world.events.list({ types: ["town.publish-cleared"], limit: 10 })])).not.toContain(TOKEN);
    expect(world.clearPublish()).toEqual({ cleared: false });
  });

  it("without a data key a token is refused (409) and nothing is stored", () => {
    vi.stubEnv("MUSTER_TOWN_DATA_KEY", "");
    vi.stubEnv("AGENT_TOWN_DATA_KEY", "");
    const { world } = freshWorld();
    expect(() => world.setPublish({ repoUrl: "https://github.com/acme/town-docs", token: TOKEN })).toThrow(/MUSTER_TOWN_DATA_KEY/);
    expect(world.town.get().publish).toBeUndefined();
  });

  it("the hourly export (worker) pushes to the World's repo and records lastPush*; a failure records lastPushError, a fixed one clears it", async () => {
    const { world } = freshWorld();
    const bare = bareRepo();
    world.setPublish({ repoUrl: `file://${tempDir()}/nope.git`, token: TOKEN });
    const dir = tempDir();
    const bad = await world.exportOffThread(dir);
    world.recordExport(bad);
    expect(bad.commit).not.toBeNull();
    expect(world.town.get().publish).toMatchObject({ lastPushAt: null, lastPushCommit: null, lastPushError: expect.stringMatching(/^git (fetch|push): /) });
    world.setPublish({ repoUrl: bare.url });
    const ok = await world.exportOffThread(dir);
    world.recordExport(ok);
    expect(ok.changed).toBe(true); // the publish-set events changed the event log
    expect(head(bare.dir)).toBe(ok.commit);
    expect(world.town.get().publish).toMatchObject({ tokenSet: true, lastPushCommit: ok.commit, lastPushError: null, lastPushAt: ok.pushedAt });
  });

  it("hosted isolation (kr_sqbsdpaju8): each World pushes only its own export to its own repo", async () => {
    const a = freshWorld().world, b = freshWorld().world;
    a.town.set({ name: "Alpha Town" });
    b.town.set({ name: "Beta Town" });
    const ra = bareRepo(), rb = bareRepo();
    a.setPublish({ repoUrl: ra.url, token: "tok-alpha-123" });
    b.setPublish({ repoUrl: rb.url, token: "tok-beta-456" });
    const xa = await a.exportOffThread(tempDir());
    const xb = await b.exportOffThread(tempDir());
    a.recordExport(xa);
    b.recordExport(xb);
    expect(JSON.parse(show(ra.dir, "town.json")).name).toBe("Alpha Town");
    expect(JSON.parse(show(rb.dir, "town.json")).name).toBe("Beta Town");
    expect(head(ra.dir)).toBe(xa.commit);
    expect(head(rb.dir)).toBe(xb.commit);
    expect(a.town.get().publish?.lastPushCommit).toBe(xa.commit);
    expect(b.town.get().publish?.lastPushCommit).toBe(xb.commit);
    expect(b.publishTarget()?.token).toBe("tok-beta-456");
  });

  it("without its own token the push uses the collective's GH_TOKEN (1:1 mt_z1b38bwg98); tokenSource says which, live", () => {
    const { world } = freshWorld();
    world.setPublish({ repoUrl: "https://github.com/acme/town-docs" });
    expect(world.publishTarget()).toMatchObject({ token: null });
    expect(world.snapshot().town.publish?.tokenSource).toBe("none");
    world.secrets.put(REPO_TOKEN_SECRET, { value: "gh-collective-789" }, null);
    expect(world.publishTarget()?.token).toBe("gh-collective-789");
    expect(world.snapshot().town.publish).toMatchObject({ tokenSet: false, tokenSource: "collective" });
    expect(world.town.get().publish?.tokenSource).toBeUndefined();
    // its own token wins over GH_TOKEN
    expect(world.setPublish({ repoUrl: "https://github.com/acme/town-docs", token: TOKEN }).tokenSource).toBe("own");
    expect(world.publishTarget()?.token).toBe(TOKEN);
    world.clearPublish();
    expect(world.snapshot().town.publish).toBeUndefined();
  });
});
