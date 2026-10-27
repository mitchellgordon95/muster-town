import { buildingRoleId, pickUpFlag } from "@muster-town/core";
import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const LAB = "carbon-cycle";

describe("flags routes", () => {
  it("POST /api/buildings/:id/flags is human-only; the flag shows in the in-tray; review with assigneeId delegates it", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth, by } = s;
    const manager = by("Mei");
    world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
    const mgr = { authorization: `Bearer ${world.tokens.getOrCreate("agent", manager.id)}` };
    const stranger = { authorization: `Bearer ${world.ops.createUser("Stranger").token}` };

    expect((await json(app, "POST", `/api/buildings/${LAB}/flags`, { body: { text: "Fix it" } })).status).toBe(401);
    expect((await json(app, "POST", `/api/buildings/${LAB}/flags`, { headers: stranger, body: { text: "Fix it" } })).status).toBe(403);
    expect((await json(app, "POST", `/api/buildings/${LAB}/flags`, { headers: mgr, body: { text: "Fix it" } })).status).toBe(403);
    expect((await json(app, "POST", `/api/buildings/${LAB}/flags`, { headers: auth, body: { text: "  " } })).status).toBe(400);
    const planted = await json(app, "POST", `/api/buildings/${LAB}/flags`, { headers: auth, body: { text: "Fix the banner typo\nIt says Cylce." } });
    expect(planted.status).toBe(201);
    expect(planted.body.doc).toMatchObject({ type: "flag", decision: "pending", buildingId: LAB, title: "Fix the banner typo" });
    const id = planted.body.doc.id as string;

    expect((await json(app, "GET", `/api/buildings/${LAB}/intray`)).body.reports.map((d: { id: string }) => d.id)).toContain(id);
    expect((await json(app, "GET", `/api/buildings/town-hall/intray`)).body.reports.map((d: { id: string }) => d.id)).not.toContain(id);

    expect(planted.body.doc.flagPos).toBeDefined();
    expect((await json(app, "GET", "/api/town")).body.flags.map((f: { docId: string }) => f.docId)).toEqual([id]);
    // an agent manager walks to the standing flag before deciding it
    expect((await json(app, "POST", `/api/docs/${id}/review`, { headers: mgr, body: { decision: "continue", assigneeId: by("Moss").id } })).body.error).toMatch(/Pick the flag up first/);
    pickUpFlag(world, manager, world.docs.require(id, "doc"));
    expect((await json(app, "GET", "/api/town")).body.flags).toEqual([]);
    expect((await json(app, "POST", `/api/docs/${id}/review`, { headers: mgr, body: { decision: "continue" } })).status).toBe(400);
    const decided = await json(app, "POST", `/api/docs/${id}/review`, { headers: mgr, body: { decision: "continue", assigneeId: by("Moss").id } });
    expect(decided.status).toBe(200);
    expect(decided.body.doc.decision).toBe("continue");
    expect(decided.body.assignment).toMatchObject({ agentId: by("Moss").id, title: "Fix the banner typo", lane: "directed" });
  });
});
