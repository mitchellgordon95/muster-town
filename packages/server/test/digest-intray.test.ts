/**
 * The Secretary's digest card over the API (gr_kdlogzzo5s step 3): GET /api/buildings/town-hall/intray carries the
 * latest card as `digest` (decisions live, Shipped lines, covered rollups); the rollups it archived leave `reports`,
 * a rollup with a real call stays; GET /api/review-deck has it as slide 2.
 */
import { buildingRoleId, createDoc } from "@muster-town/core";
import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const LAB = "carbon-cycle";
const body = (call: string) => `## Shipped\n**1. A banner**\n**What it is:** a banner\n**What you'd see:** the board\n**Your call:** ${call}\n\n## Decided\n- none\n## Key results\n(none)\n## Needs from Mitchell\nNothing needed.`;

describe("the digest card in the Town Hall in-tray", () => {
  it("comes first as `digest`; its archived rollups leave the list; the deck shows it as slide 2", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth, by } = s;
    const mei = by("Mei");
    world.permissions.grant(mei, buildingRoleId(LAB, "manager"));
    const sec = world.secretary.ensure()!;
    const rollup = (call: string) => createDoc(world, { type: "report", title: `Rollup: ${call}`, body: body(call), authorId: mei.id, authorKind: "agent", buildingId: LAB, state: "building", tags: ["rollup"], decision: "pending" });
    const quiet = rollup("None");
    const asks = rollup("Merge PR #12?");
    expect((await json(app, "GET", "/api/buildings/town-hall/intray", { headers: auth })).body.digest).toBeNull();

    const secAuth = { authorization: `Bearer ${world.tokens.getOrCreate("agent", sec.id)}` };
    const filed = await json(app, "POST", "/api/verbs/digest", { headers: secAuth, body: { shipped: [{ rollupId: quiet.id, line: "A banner shows today's spend", theme: "Bank and speed" }] } });
    expect(filed.status).toBe(200);

    const intray = (await json(app, "GET", "/api/buildings/town-hall/intray", { headers: auth })).body;
    expect(intray.digest).toMatchObject({ doc: { id: filed.body.result.digestId, type: "digest" }, shipped: `**Bank and speed**\n\n- A banner shows today's spend (${quiet.id})` });
    expect(intray.digest.decisions).toEqual([{ heading: "Questions in words (1)", note: null, lines: [expect.stringContaining("Merge PR #12?")] }]);
    expect(intray.digest.covered.map((r: { id: string; pending: boolean }) => [r.id, r.pending])).toEqual([[quiet.id, false], [asks.id, true]]);
    const ids = intray.reports.map((d: { id: string }) => d.id);
    expect(ids).not.toContain(quiet.id);
    expect(ids).toContain(asks.id);

    const deck = (await json(app, "GET", "/api/review-deck", { headers: auth })).body;
    expect(deck.slides.slice(0, 2).map((x: { kind: string }) => x.kind)).toEqual(["town", "digest"]);
  });

  it("POST /api/digest/run (the in-tray's Daily digest button): a human who can decide the retainer starts one run; refused for an agent, before approval, with nothing new, or while a run is live", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth, by } = s;
    const mei = by("Mei");
    const sec = world.secretary.ensure()!;
    const sched = world.secretary.ensureDigestSchedule()!;
    const meiAuth = { authorization: `Bearer ${world.tokens.getOrCreate("agent", mei.id)}` };
    expect((await json(app, "POST", "/api/digest/run", { headers: meiAuth })).status).toBe(403);
    expect((await json(app, "POST", "/api/digest/run", { headers: auth })).body.error).toMatch(/not approved/);
    expect((await json(app, "POST", `/api/schedules/${sched.id}/retainer`, { headers: auth, body: { action: "approve" } })).status).toBe(200);
    const none = await json(app, "POST", "/api/digest/run", { headers: auth });
    expect(none.status).toBe(409);
    createDoc(world, { type: "report", title: "Rollup", body: body("None"), authorId: mei.id, authorKind: "agent", buildingId: LAB, state: "building", tags: ["rollup"], decision: "pending" });
    expect((await json(app, "GET", "/api/buildings/town-hall/intray", { headers: auth })).body.digestRun).toEqual({ scheduleId: sched.id, runningId: null, refused: null });
    const ran = await json(app, "POST", "/api/digest/run", { headers: auth });
    expect(ran.status).toBe(200);
    expect(ran.body.assignment).toMatchObject({ agentId: sec.id, lane: "retainer", sourceId: sched.id });
    expect((await json(app, "GET", "/api/buildings/town-hall/intray", { headers: auth })).body.digestRun.runningId).toBe(ran.body.assignment.id);
    expect((await json(app, "GET", "/api/buildings/town-hall/intray", { headers: meiAuth })).body.digestRun).toBeNull();
    expect((await json(app, "POST", "/api/digest/run", { headers: auth })).status).toBe(409);
  });
});
