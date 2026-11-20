/**
 * The asks routes and the seen table (docs/legible-delegation.md §4-5, build steps 3-4): GET /api/asks and /api/asks/:id,
 * decide and defer, a signed-in human's opens recorded (never an agent's), and stale claim results re-run on open.
 */
import { buildingRoleId, townRoleId } from "@muster-town/core";
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
      title: "Fund the banner line at 100k",
      body: "This is a new proposal. You have not decided on it before.\nNothing is spent yet. It has one step, and none is done yet.\nIf you fund: the banner ships.\nIf you reject: nothing runs.",
      recommendation: "Fund: one session does it.",
      claims: [{ text: "The lab has a name", check: { kind: "api" as const, ref: "GET /api/buildings/carbon-cycle /building/name" } }],
    };
    const r = await world.verbs.propose_grant(mei, { title: "A test grant proposal", keyResults: [{ text: "A banner line", howToCheck: "Open the banner" }], objective: "Banner", steps: [{ title: "Step 1", description: "Do the work", size: "M" }], stopCondition: "done", askTokens: 100_000, findingsDocIds: [], approach: "", note: "", ask: card });
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
    const req = await world.verbs.request_human(by("Noor"), { worth: "Only a human can do this; the work waits on it.", title: "Photograph the slump", body: "From the north side.", kind: "observation" });
    // the request writes a need; the lab's manager renders its ask (1:1 mt_t65exni4et)
    await world.verbs.ask(mei, { type: "do", targetId: req.id, title: "Photograph the slump", body: "Worth leaving the queue: only a human can stand there.", branches: [{ label: "Done" }, { label: "Decline" }], recommendation: "Press Done after the photo." });
    const reqAsk = world.asks.first("targetKind = 'request' AND targetId = ?", [req.id])!;
    expect((await json(app, "POST", `/api/asks/${reqAsk.id}/defer`, { headers: agent, body: { until: "the rain stops" } })).status).toBe(403);
    expect((await json(app, "POST", `/api/asks/${reqAsk.id}/defer`, { headers: auth, body: { until: "the rain stops" } })).body.ask).toMatchObject({ status: "deferred", deferredUntil: "the rain stops" });
    expect((await json(app, "POST", `/api/asks/${reqAsk.id}/decide`, { headers: auth, body: { decision: "Done" } })).body.ask).toMatchObject({ status: "decided", decision: "Done" });
    expect((await json(app, "GET", "/api/asks/ak_nothere")).status).toBe(404);
  }, 30_000);

  it("a non-admin captain of a leaf goal decides a click ask from a building under it (200), and is refused one from another building (403) (gr_0vuiuqcw8p)", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, seed, by } = s;
    const admin = world.ops.ensureAvatar(seed.admin.id);
    const mei = by("Mei");
    world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
    world.permissions.grant(mei, buildingRoleId(LAB, "manager"));
    const cap = world.ops.createUser("Cap");
    world.permissions.grant({ kind: "user", id: cap.user.id }, townRoleId("member"));
    const capH = { authorization: `Bearer ${cap.token}` };
    const leaf = world.goalTree.create(admin, { parentId: "gl_trust", text: "The lab's leaf goal" });
    world.goalTree.attach(admin, LAB, leaf.id);
    world.goalTree.update(admin, leaf.id, { ownerId: cap.user.id });
    const click = { type: "click" as const, body: "Mei has waited on this since Nov 6. Open the page once.", branches: [{ label: "Done" }, { label: "Decline" }], recommendation: "Press Done." };
    await world.verbs.ask(mei, { ...click, title: "Merge the lab docs" });
    const inside = world.asks.first("buildingId = ? AND status = 'open'", [LAB])!;
    // another building, attached outside the captain's leaf goal, whose manager files the other ask
    const other = world.ops.createBuilding(admin, { name: "Other Lab", goalId: "gl_trust" });
    const noor = by("Noor");
    world.agents.patch(noor.id, { homeBuildingId: other.id });
    world.ops.updateBuilding(admin, other.id, { managerAgentId: noor.id });
    world.permissions.grant(noor, buildingRoleId(other.id, "manager"));
    await world.verbs.ask(world.agents.require(noor.id), { ...click, title: "Set the mail key" });
    const outside = world.asks.first("buildingId = ? AND status = 'open'", [other.id])!;
    const th = world.buildings.first("kind = 'town-hall'")!;

    // the in-tray routes each ask by its own id: Mine and the buttons follow the captain's subtree
    const tray = await json(app, "GET", `/api/buildings/${th.id}/intray`, { headers: capH });
    expect(tray.body.routes[inside.id]).toMatchObject({ goalId: leaf.id, mine: true, canDecide: true });
    expect(tray.body.defaultView).toBe("mine");
    expect(tray.body.routes[outside.id]).toMatchObject({ mine: false, canDecide: false });
    expect((await json(app, "POST", `/api/asks/${outside.id}/decide`, { headers: capH, body: { decision: "Done" } })).status).toBe(403);
    const decided = await json(app, "POST", `/api/asks/${inside.id}/decide`, { headers: capH, body: { decision: "Done" } });
    expect(decided.status).toBe(200);
    expect(decided.body.ask).toMatchObject({ status: "decided", decidedBy: cap.user.id });
  }, 30_000);
});
