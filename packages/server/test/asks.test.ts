/**
 * The asks routes and the seen table (docs/legible-delegation.md §4-5, build steps 3-4): GET /api/asks and /api/asks/:id,
 * decide and defer, a signed-in human's opens recorded (never an agent's), and stale claim results re-run on open.
 */
import { buildingRoleId } from "@muster-town/core";
import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const LAB = "carbon-cycle";

describe("asks over the API (docs/legible-delegation.md §4-5)", () => {
  it("lists open asks, records what a signed-in human opens (never an agent), re-runs a stale claim check on open, and decides and defers", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth, seed, by } = s;
    const mei = by("Mei");
    world.ops.updateBuilding(world.ops.ensureAvatar(seed.admin.id), LAB, { managerAgentId: mei.id });
    world.permissions.grant(mei, buildingRoleId(LAB, "manager"));
    const agent = { authorization: `Bearer ${world.tokens.getOrCreate("agent", mei.id)}` };
    const card = {
      body: "This is a new proposal. You have not decided on it before.\nNothing is spent yet. It has one step, and none is done yet.\nIf you fund: the banner ships.\nIf you reject: nothing runs.",
      recommendation: "Fund: one session does it.",
      claims: [{ text: "The lab has a name", check: { kind: "api" as const, ref: "GET /api/buildings/carbon-cycle /building/name" } }],
    };
    const r = await world.verbs.propose_grant(mei, { keyResults: [{ text: "A banner line", howToCheck: "Open the banner" }], objective: "Banner", steps: [{ title: "Step 1", description: "Do the work", size: "M" }], stopCondition: "done", askTokens: 100_000, findingsDocIds: [], approach: "", note: "", ask: card });
    const list = await json(app, "GET", "/api/asks");
    expect(list.status).toBe(200);
    const ask = list.body.asks.find((a: { targetId: string }) => a.targetId === r.grantId);
    expect(ask).toMatchObject({ type: "money", recommendation: card.recommendation, tags: [] });
    const seen = () => world.db.prepare("SELECT userId, targetKind, targetId FROM seen ORDER BY targetKind").all();

    // an agent reading writes no seen row; a signed-in human's open does, and the stale (never run) api check runs in-process
    expect((await json(app, "GET", `/api/asks/${ask.id}`, { headers: agent })).status).toBe(200);
    expect(seen()).toEqual([]);
    const opened = await json(app, "GET", `/api/asks/${ask.id}`, { headers: auth });
    expect(opened.body.ask.claims[0].result).toMatchObject({ ok: true, note: expect.stringMatching(/^\/building\/name is "/) });
    const at = opened.body.ask.claims[0].result.at;
    // fresh: the next open shows the stored result, not a new run
    expect((await json(app, "GET", `/api/asks/${ask.id}`)).body.ask.claims[0].result.at).toBe(at);
    // older than 5 minutes: re-run on open
    const stored = world.asks.require(ask.id);
    world.asks.upsert({ ...stored, claims: stored.claims.map((c) => ({ ...c, result: { ...c.result!, at: new Date(Date.now() - 6 * 60_000).toISOString() } })) });
    const reopened = await json(app, "GET", `/api/asks/${ask.id}`);
    expect(Date.now() - Date.parse(reopened.body.ask.claims[0].result.at)).toBeLessThan(60_000);

    // the grant and a report, opened by the human
    const rep = await world.verbs.submit_report(by("Noor"), { title: "Done", body: "## What I did\nx", verdict: "stop" });
    expect((await json(app, "GET", `/api/grants/${r.grantId}`, { headers: auth })).status).toBe(200);
    expect((await json(app, "GET", `/api/docs/${rep.id}`, { headers: auth })).status).toBe(200);
    expect(seen()).toEqual([
      { userId: seed.admin.id, targetKind: "ask", targetId: ask.id },
      { userId: seed.admin.id, targetKind: "grant", targetId: r.grantId },
      { userId: seed.admin.id, targetKind: "report", targetId: rep.id },
    ]);

    // decide and defer: a human only
    const req = await world.verbs.request_human(by("Noor"), { title: "Photograph the slump", body: "From the north side.", kind: "observation" });
    const reqAsk = world.asks.first("targetKind = 'request' AND targetId = ?", [req.id])!;
    expect((await json(app, "POST", `/api/asks/${reqAsk.id}/defer`, { headers: agent, body: { until: "the rain stops" } })).status).toBe(403);
    expect((await json(app, "POST", `/api/asks/${reqAsk.id}/defer`, { headers: auth, body: { until: "the rain stops" } })).body.ask).toMatchObject({ status: "deferred", deferredUntil: "the rain stops" });
    expect((await json(app, "POST", `/api/asks/${reqAsk.id}/decide`, { headers: auth, body: { decision: "Done" } })).body.ask).toMatchObject({ status: "decided", decision: "Done" });
    expect((await json(app, "GET", "/api/asks/ak_nothere")).status).toBe(404);
  }, 30_000);
});
