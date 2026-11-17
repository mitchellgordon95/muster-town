import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { makeProdWatch, PULL_RETRY_MS, PULL_SPACING_MS } from "../src/prod-watch.ts";
import type { CmdResult, CommandRunner, RedeployRequest } from "../src/redeploy.ts";

const LIVE = "a".repeat(40), TIP = "b".repeat(40), TIP2 = "c".repeat(40);

/** A fake git: `fetch` fails while `fetchFails`, the tip is `tip`, `files` are the diff, `ancestor` answers merge-base. */
function fakeGit(s: { tip: string; files: string[]; fetchFails?: boolean; ancestor?: boolean }) {
  const calls: string[][] = [];
  const ok = (stdout = ""): CmdResult => ({ code: 0, stdout, stderr: "" });
  const run: CommandRunner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "fetch") return s.fetchFails ? { code: 128, stdout: "", stderr: "fatal: unable to access" } : ok();
    if (args[0] === "rev-parse") return ok(`${s.tip}\n`);
    if (args[0] === "merge-base") return s.ancestor === false ? { code: 1, stdout: "", stderr: "" } : ok();
    if (args[0] === "diff") return ok(s.files.join("\n") + "\n");
    return { code: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
  };
  return { run, calls, s };
}

function setup(s: Parameters<typeof fakeGit>[0], o: { running?: boolean; startedAgoMs?: number } = {}) {
  const g = fakeGit(s);
  let t = Date.parse("2026-11-17T12:00:00Z");
  const requests: RedeployRequest[] = [];
  const events: { text: string; payload: Record<string, unknown> }[] = [];
  const state = { running: o.running ?? false };
  const startedAt = new Date(t - (o.startedAgoMs ?? 60 * 60_000)).toISOString();
  const w = makeProdWatch({
    repoRoot: mkdtempSync(join(tmpdir(), "prod-watch-")), branch: "prod", run: g.run, now: () => t,
    live: () => LIVE, startedAt: () => startedAt,
    redeployer: { running: () => state.running, redeploy: (r) => { requests.push(r); return { started: true }; } },
    event: (text, payload) => events.push({ text, payload }),
  });
  return { w, g, requests, events, state, advance: (ms: number) => { t += ms; } };
}

describe("prod watch: the server pulls its own deploys", () => {
  test("prod ahead with a code change: one redeploy, requested by the prod branch; the next ticks wait out the spacing", async () => {
    const { w, g, requests } = setup({ tip: TIP, files: ["docs/log.d/x.md", "packages/server/src/app.ts"] });
    expect(await w.tick()).toBe("redeploy");
    expect(requests).toEqual([{ image: false, requestedBy: "prod branch" }]);
    expect(g.calls[0]).toEqual(["git", "fetch", "-q", "--no-write-fetch-head", "--no-tags", "origin", "+refs/heads/prod:refs/remotes/origin/prod"]);
    // same tip (the run failed, no restart): not again for an hour
    expect(await w.tick()).toBe("spacing");
    expect(requests).toHaveLength(1);
  });

  test("the same tip is retried after PULL_RETRY_MS; a newer tip after PULL_SPACING_MS", async () => {
    const { w, g, requests, advance } = setup({ tip: TIP, files: ["packages/core/src/x.ts"] });
    expect(await w.tick()).toBe("redeploy");
    advance(PULL_SPACING_MS);
    expect(await w.tick()).toBe("spacing");
    g.s.tip = TIP2;
    expect(await w.tick()).toBe("redeploy");
    g.s.tip = TIP2;
    advance(PULL_RETRY_MS - 1);
    expect(await w.tick()).toBe("spacing");
    advance(1);
    expect(await w.tick()).toBe("redeploy");
    expect(requests).toHaveLength(3);
  });

  test("docs-only (docs/, .github/, top-level *.md): no redeploy; docs/manual.md counts as code; one diff per pair", async () => {
    const { w, g, requests } = setup({ tip: TIP, files: ["docs/log.d/x.md", ".github/workflows/ci.yml", "README.md"] });
    expect(await w.tick()).toBe("docs-only");
    expect(await w.tick()).toBe("docs-only");
    expect(g.calls.filter((c) => c[1] === "diff")).toHaveLength(1);
    expect(requests).toEqual([]);
    g.s.tip = TIP2;
    g.s.files = ["docs/manual.md"];
    expect(await w.tick()).toBe("redeploy");
  });

  test("not ahead: the tip is the live commit, or live is not its ancestor: nothing is called", async () => {
    const cur = setup({ tip: LIVE, files: [] });
    expect(await cur.w.tick()).toBe("current");
    const back = setup({ tip: TIP, files: ["packages/x.ts"], ancestor: false });
    expect(await back.w.tick()).toBe("not-ahead");
    expect([...cur.requests, ...back.requests]).toEqual([]);
  });

  test("a running redeploy: the tick is skipped without touching git; a server started under the spacing waits", async () => {
    const busy = setup({ tip: TIP, files: ["packages/x.ts"] }, { running: true });
    expect(await busy.w.tick()).toBe("busy");
    expect(busy.g.calls).toEqual([]);
    busy.state.running = false;
    expect(await busy.w.tick()).toBe("redeploy");
    const fresh = setup({ tip: TIP, files: ["packages/x.ts"] }, { startedAgoMs: PULL_SPACING_MS - 1000 });
    expect(await fresh.w.tick()).toBe("spacing");
    fresh.advance(1000);
    expect(await fresh.w.tick()).toBe("redeploy");
  });

  test("a fetch error is one event, then quiet; a working fetch says so once", async () => {
    const { w, g, events, requests } = setup({ tip: TIP, files: ["packages/x.ts"], fetchFails: true });
    expect(await w.tick()).toBe("fetch-failed");
    expect(await w.tick()).toBe("fetch-failed");
    expect(await w.tick()).toBe("fetch-failed");
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toMatch(/git fetch origin prod failed \(exit 128\)/);
    expect(events[0]!.payload).toMatchObject({ prodWatch: true, ok: false });
    g.s.fetchFails = false;
    expect(await w.tick()).toBe("redeploy");
    expect(events.map((e) => e.text)).toEqual([expect.stringMatching(/failed/), "Prod watch: git fetch origin prod works again"]);
    expect(requests).toHaveLength(1);
  });
});
