import { buildingRoleId, townRoleId } from "@muster-town/core";
import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe("agent permissions routes", () => {
  it("GET /api/agents/:id has effectivePermissions; PATCH permissions is owner-or-admin", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth } = s;
    const mgr = world.ops.createUser("Mgr");
    world.permissions.grant({ kind: "user", id: mgr.user.id }, buildingRoleId("carbon-cycle", "manager"));
    world.permissions.grant({ kind: "user", id: mgr.user.id }, townRoleId("member"));
    const mgrAuth = { authorization: `Bearer ${mgr.token}` };
    const reg = await json(app, "POST", "/api/agents/visitors", { headers: mgrAuth, body: { name: "Mgr's Claude", buildingId: "carbon-cycle" } });
    expect(reg.status).toBe(201);
    const id = reg.body.agent.id as string;
    const agentAuth = { authorization: `Bearer ${reg.body.token}` };

    const got = await json(app, "GET", `/api/agents/${id}`, { headers: mgrAuth });
    expect(got.status).toBe(200);
    expect(got.body.effectivePermissions).toContain("building.assign");
    expect(got.body.permissions).toMatchObject({ inheritsOwner: true, deniedPermissions: [], ownerName: "Mgr", canEdit: true });
    expect(got.body.permissions.ownerPermissions).toContain("building.assign");
    const anon = await json(app, "GET", `/api/agents/${id}`);
    expect(anon.body.effectivePermissions).toContain("building.assign");
    expect(anon.body.permissions.canEdit).toBe(false);
    expect(anon.body.permissions.ownerPermissions).toBeUndefined();

    const stranger = world.ops.createUser("Stranger");
    world.permissions.grant({ kind: "user", id: stranger.user.id }, townRoleId("member"));
    const strangerAuth = { authorization: `Bearer ${stranger.token}` };
    expect((await json(app, "PATCH", `/api/agents/${id}/permissions`, { headers: strangerAuth, body: { inheritsOwner: false } })).status).toBe(403);
    expect((await json(app, "PATCH", `/api/agents/${id}/permissions`, { headers: agentAuth, body: { inheritsOwner: false } })).status).toBe(403);
    expect((await json(app, "PATCH", `/api/agents/${id}/permissions`, { body: { inheritsOwner: false } })).status).toBe(401);
    expect((await json(app, "PATCH", `/api/agents/${id}/permissions`, { headers: mgrAuth, body: { deniedPermissions: ["nope"] } })).status).toBe(400);

    const denied = await json(app, "PATCH", `/api/agents/${id}/permissions`, { headers: mgrAuth, body: { deniedPermissions: ["building.assign"] } });
    expect(denied.status).toBe(200);
    expect(denied.body.agent.deniedPermissions).toEqual(["building.assign"]);
    expect(denied.body.effectivePermissions).not.toContain("building.assign");
    expect(denied.body.effectivePermissions).toContain("building.review");

    const off = await json(app, "PATCH", `/api/agents/${id}/permissions`, { headers: auth, body: { inheritsOwner: false } });
    expect(off.status).toBe(200);
    expect(off.body.permissions.inheritsOwner).toBe(false);
    expect(off.body.effectivePermissions).toEqual(["meeting.attend"]);
  });
});
