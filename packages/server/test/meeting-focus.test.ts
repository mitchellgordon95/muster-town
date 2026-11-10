/**
 * PUT /api/meetings/:id/focus (Mitchell 2026-11-09: "i think the secretary should know what's open please"): the decision
 * queue tells the human's Secretary 1:1 which item is on screen. Only that 1:1's human, signed in, may set it; another
 * human, an agent token and a guest are refused; the same item twice writes nothing.
 */
import { townRoleId } from "@muster-town/core";
import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe("PUT /api/meetings/:id/focus", () => {
  it("only the 1:1's human sets the open item; another human, an agent and a guest are refused; the same item twice is a no-op", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth } = s;
    const sec = world.secretary.ensure()!;
    const th = world.buildings.first("kind = 'town-hall'")!;
    const m = (await json(app, "POST", `/api/buildings/${th.id}/one-on-one`, { headers: auth, body: { agentId: sec.id } })).body.meeting;
    const url = `/api/meetings/${m.id}/focus`;

    const set = await json(app, "PUT", url, { headers: auth, body: { kind: "grant", id: "gr_x" } });
    expect(set.status).toBe(200);
    expect(set.body.meeting.focus).toMatchObject({ kind: "grant", id: "gr_x" });
    const again = await json(app, "PUT", url, { headers: auth, body: { kind: "grant", id: "gr_x" } });
    expect(again.body.meeting.focus.at).toBe(set.body.meeting.focus.at);

    // another human (an admin, even), the agent's own token, a guest
    const ana = world.ops.createUser("Ana");
    world.permissions.grant({ kind: "user", id: ana.user.id }, townRoleId("admin"));
    expect((await json(app, "PUT", url, { headers: { authorization: `Bearer ${ana.token}` }, body: null })).status).toBe(403);
    const agent = { authorization: `Bearer ${world.tokens.getOrCreate("agent", sec.id)}` };
    expect((await json(app, "PUT", url, { headers: agent, body: { kind: "ask", id: "ak_x" } })).status).toBe(403);
    expect((await json(app, "PUT", url, { body: { kind: "ask", id: "ak_x" } })).status).toBe(401);
    expect(world.meetings.require(m.id).focus).toMatchObject({ kind: "grant", id: "gr_x" });

    // a kind the queue doesn't have is a bad request; null clears it
    expect((await json(app, "PUT", url, { headers: auth, body: { kind: "planet", id: "x" } })).status).toBe(400);
    const cleared = await json(app, "PUT", url, { headers: auth, body: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.meeting.focus).toBeNull();
    // JSON null as the web sends it clears too
    await json(app, "PUT", url, { headers: auth, body: { kind: "doc", id: "dc_x" } });
    const res = await app.inject({ method: "PUT", url, headers: { ...auth, "content-type": "application/json" }, payload: "null" });
    expect(res.statusCode).toBe(200);
    expect(world.meetings.require(m.id).focus).toBeNull();
  });
});
