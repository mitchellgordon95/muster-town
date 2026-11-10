/**
 * Load-bearing claims with checks (docs/legible-delegation.md §5, build step 4): pr against a stubbed GitHub, url
 * through the SSRF guard (faked), api in-process, kr by its howToCheck, manual left alone; results stored on the ask,
 * stale after 5 minutes, one ask.checked event per run.
 */
import type { Ask } from "@muster-town/schema";
import { describe, expect, it } from "vitest";
import { buildingRoleId } from "../src/index.ts";
import { CLAIM_STALE_MS, claimsStale, readsAsks, runClaimChecks, urlOfHowToCheck } from "../src/ask-checks.ts";
import { createAsk } from "../src/asks.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

/** A fake GitHub: PR 392 open, mergeable and green; 393 red; 394 merged. */
function fakeGitHub(seen: string[]): typeof fetch {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push(`${url} ${(init?.headers as Record<string, string> | undefined)?.Authorization ?? "anon"}`);
    const pr = /\/pulls\/(\d+)$/.exec(url)?.[1];
    if (pr === "392") return json({ state: "open", merged: false, mergeable: true, head: { sha: "aaa" } });
    if (pr === "393") return json({ state: "open", merged: false, mergeable: true, head: { sha: "bbb" } });
    if (pr === "394") return json({ state: "closed", merged: true, mergeable: null, head: { sha: "ccc" } });
    if (url.includes("/commits/aaa/check-runs")) return json({ check_runs: [{ name: "check", status: "completed", conclusion: "success" }] });
    if (url.includes("/commits/bbb/check-runs")) return json({ check_runs: [{ name: "check", status: "completed", conclusion: "failure" }] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("claim checks (docs/legible-delegation.md §5)", () => {
  it("runs pr, url, api and kr checks, leaves manual alone, stores the results and goes stale after 5 minutes", async () => {
    const { world, admin, by } = seededWorld();
    const mei = by("Mei");
    world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
    world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
    world.town.set({ workspace: { path: ".", tools: [], branchPrefix: "agent", base: "main", repoUrl: "https://github.com/o/town.git" } });
    const g = world.grantDesk.propose(mei, world.grantDesk.create(mei, LAB, { keyResults: [{ text: "Health answers", howToCheck: "curl -s https://muster.town/api/health | jq .commit" }, { text: "Looks right", howToCheck: "Open the lab board" }], objective: "o", steps: [{ title: "Step 1", description: "d", size: "M" }], stopCondition: "s", askTokens: 1000 }).id);
    const [krCurl, krManual] = world.grantDesk.keyResultsOf(g.id);
    world.host.apiGet = async (path) => path === "/api/buildings/carbon-cycle" ? { status: 200, body: { building: { name: "Carbon Lab", intray: 0 } } } : { status: 404, body: { error: "nope" } };
    const { ask } = createAsk(world, {
      type: "click", buildingId: LAB, sourceDocId: null, title: "Merge the self-host docs", branches: [{ label: "Done" }, { label: "Decline" }],
      claims: [
        { text: "PR #392 is green and mergeable", check: { kind: "pr", ref: "392" } },
        { text: "PR 393 is green", check: { kind: "pr", ref: "https://github.com/o/town/pull/393" } },
        { text: "PR 394 landed", check: { kind: "pr", ref: "#394" } },
        { text: "The site answers", check: { kind: "url", ref: "https://muster.town/workshop/" } },
        { text: "Fly's private network is never fetched", check: { kind: "url", ref: "https://town.internal/api/health" } },
        { text: "The building has a name", check: { kind: "api", ref: "GET /api/buildings/carbon-cycle /building/name Carbon Lab" } },
        { text: "The in-tray is empty", check: { kind: "api", ref: "GET /api/buildings/carbon-cycle /building/intray 3" } },
        { text: "Health answers", check: { kind: "kr", ref: krCurl!.id } },
        { text: "Looks right", check: { kind: "kr", ref: krManual!.id } },
        { text: "Mitchell saw it live", check: { kind: "manual" } },
      ],
    });
    expect(claimsStale(world, ask)).toBe(true);
    const gh: string[] = [], urls: string[] = [];
    const t0 = new Date("2026-11-08T12:00:00Z");
    const checked = await runClaimChecks(world, ask, {
      fetch: fakeGitHub(gh), now: () => t0,
      getUrl: async (url, opts) => { urls.push(`${url} ${opts.timeoutMs} ${opts.statusOnly}`); return { status: url.includes("/workshop/") ? 200 : 301, body: "" }; },
    });
    const r = (i: number) => checked.claims[i]!.result;
    expect(r(0)).toEqual({ ok: true, at: t0.toISOString(), note: "PR #392: green, mergeable" });
    expect(r(1)).toMatchObject({ ok: false, note: "PR #393: red: check failed, mergeable" });
    expect(r(2)).toMatchObject({ ok: true, note: "PR #394 is merged" });
    expect(r(3)).toMatchObject({ ok: true, note: "HTTP 200" });
    expect(r(4)).toMatchObject({ ok: false, note: "refused: town.internal is a private host" });
    expect(r(5)).toMatchObject({ ok: true, note: "/building/name is \"Carbon Lab\", expected Carbon Lab" });
    expect(r(6)).toMatchObject({ ok: false, note: "/building/intray is 0, expected 3" });
    expect(r(7)).toMatchObject({ ok: true, note: "HTTP 301" }); // a 3xx answers: 200-399 passes
    expect(r(8)).toBeUndefined(); // a howToCheck that is no curl or URL is a manual check
    expect(r(9)).toBeUndefined();
    // GitHub through the collective's repo, the URL checks through the guard with a 5 s timeout, status only
    expect(gh.every((u) => u.startsWith("https://api.github.com/repos/o/town/"))).toBe(true);
    expect(urls).toEqual(["https://muster.town/workshop/ 5000 true", "https://muster.town/api/health 5000 true"]);
    expect(world.asks.require(ask.id).claims[0]!.result).toEqual(r(0));
    expect(world.events.list({ types: ["ask.checked"] }).at(-1)).toMatchObject({ text: expect.stringMatching(/Checked 8 claims .*: 5 passed/) });
    // fresh for 5 minutes, stale after
    const stored = world.asks.require(ask.id);
    expect(claimsStale(world, stored, t0.getTime() + CLAIM_STALE_MS - 1000)).toBe(false);
    expect(claimsStale(world, stored, t0.getTime() + CLAIM_STALE_MS + 1000)).toBe(true);
    // an ask with only manual claims has nothing to check
    const manual: Ask = { ...stored, claims: [stored.claims[9]!] };
    expect(claimsStale(world, manual)).toBe(false);
    expect(await runClaimChecks(world, manual, { fetch: () => { throw new Error("no call"); } })).toBe(manual);
  }, 30_000);

  it("refuses an api check on /api/asks (reading an ask re-runs its checks) and stores each result as its check finishes", async () => {
    const { world, by } = seededWorld();
    const mei = by("Mei");
    world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
    const called: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    world.host.apiGet = async (path) => {
      called.push(path);
      if (path === "/api/slow") await slow;
      return { status: 200, body: { ok: true } };
    };
    for (const p of ["/api/asks/ak_x", "/api/asks", "/api//asks/ak_x", "/api/ASKS/ak_x", "/api/%61sks/ak_x"]) expect(readsAsks(p)).toBe(true);
    expect(readsAsks("/api/askstats")).toBe(false);
    expect(readsAsks("/api/buildings/x")).toBe(false);
    const { ask } = createAsk(world, {
      type: "money", buildingId: LAB, sourceDocId: null, by: mei.id, title: "Recursion", body: "b", recommendation: "r",
      branches: [{ label: "Yes" }, { label: "No" }],
      claims: [
        { text: "Reads an ask", check: { kind: "api", ref: "GET /api/asks/ak_x /ask/status open" } },
        { text: "Fast", check: { kind: "api", ref: "GET /api/fast /ok" } },
        { text: "Slow", check: { kind: "api", ref: "GET /api/slow /ok" } },
      ],
    });
    const run = runClaimChecks(world, ask);
    await new Promise((r) => setTimeout(r, 10));
    // the refused and the fast results are stored while the slow check still runs
    const mid = world.asks.require(ask.id).claims;
    expect(mid[0]!.result).toMatchObject({ ok: false, note: expect.stringMatching(/^refused: an api check never reads \/api\/asks/) });
    expect(mid[1]!.result).toMatchObject({ ok: true });
    expect(mid[2]!.result).toBeUndefined();
    release();
    const done = await run;
    expect(done.claims[2]!.result).toMatchObject({ ok: true });
    expect(called).toEqual(["/api/fast", "/api/slow"]);
  });

  it("reads the URL a key result's howToCheck runs", () => {
    expect(urlOfHowToCheck("curl -s https://muster.town/api/health | jq .commit")).toBe("https://muster.town/api/health");
    expect(urlOfHowToCheck("https://muster.town/workshop/")).toBe("https://muster.town/workshop/");
    expect(urlOfHowToCheck("Open the lab board and look")).toBeNull();
  });
});
