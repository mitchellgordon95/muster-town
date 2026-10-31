import { townRoleId } from "@muster-town/core";
import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

// "Ask to captain this goal" (grant gr_bwm0iz7rwl): a member asks, the request is a Town Hall in-tray item routed to the
// goal's current captain, and accepting sets the goal's ownerId.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function setup() {
  const s = await seededApp();
  cleanups.push(s.close);
  const person = (name: string, role: "member" | "visitor") => {
    const { user, token } = s.world.ops.createUser(name);
    s.world.permissions.grant({ kind: "user", id: user.id }, townRoleId(role));
    return { user, headers: { authorization: `Bearer ${token}` } };
  };
  const goal = (await json(s.app, "POST", "/api/goals", { headers: s.auth, body: { parentId: "gl_trust", text: "Grant pages show sessions" } })).body.goal;
  const th = s.world.buildings.first("kind = 'town-hall'")!;
  return { ...s, ana: person("Ana", "member"), vic: person("Vic", "visitor"), goal, th };
}
type Node = { id: string; ownerId: string | null; children: Node[] };
const find = (n: Node, id: string): Node | undefined => n.id === id ? n : n.children.map((c) => find(c, id)).find(Boolean);

describe("captain requests over HTTP", () => {
  it("guest 401, visitor 403; a member asks → in-tray row for the admins → accept → GET /api/goals has ownerId", async () => {
    const { app, auth, ana, vic, goal, th } = await setup();
    const url = `/api/goals/${goal.id}/captain-requests`;
    expect((await json(app, "POST", url, { body: {} })).status).toBe(401);
    expect((await json(app, "POST", url, { headers: vic.headers, body: {} })).status).toBe(403);

    const asked = await json(app, "POST", url, { headers: ana.headers, body: { note: "I run this work" } });
    expect(asked.status).toBe(201);
    const id = asked.body.captainRequest.id;
    expect((await json(app, "POST", url, { headers: ana.headers, body: {} })).status).toBe(409);
    expect((await json(app, "GET", url)).body.captainRequests).toEqual([expect.objectContaining({ id, name: "Ana" })]);

    const tray = await json(app, "GET", `/api/buildings/${th.id}/intray`, { headers: auth });
    expect(tray.body.captains).toEqual([expect.objectContaining({ id, goalId: goal.id, goalText: "Grant pages show sessions", name: "Ana", note: "I run this work", captainName: "the town admins" })]);
    expect(tray.body.routes[id]).toMatchObject({ mine: true, canDecide: true, ownerName: "the town admins" });

    expect((await json(app, "POST", `/api/captain-requests/${id}/decide`, { headers: ana.headers, body: { action: "accept" } })).status).toBe(403);
    const ok = await json(app, "POST", `/api/captain-requests/${id}/decide`, { headers: auth, body: { action: "accept", note: "yours" } });
    expect(ok.status).toBe(200);
    expect(ok.body.captainRequest).toMatchObject({ status: "accepted", decisionNote: "yours" });
    const tree = (await json(app, "GET", "/api/goals")).body.root as Node;
    expect(find(tree, goal.id)?.ownerId).toBe(ana.user.id);
    expect((await json(app, "GET", `/api/buildings/${th.id}/intray`, { headers: auth })).body.captains).toEqual([]);
  });

  it("decline leaves ownerId unset", async () => {
    const { app, auth, ana, goal } = await setup();
    const id = (await json(app, "POST", `/api/goals/${goal.id}/captain-requests`, { headers: ana.headers, body: {} })).body.captainRequest.id;
    const no = await json(app, "POST", `/api/captain-requests/${id}/decide`, { headers: auth, body: { action: "decline" } });
    expect(no.body.captainRequest.status).toBe("declined");
    const tree = (await json(app, "GET", "/api/goals")).body.root as Node;
    expect(find(tree, goal.id)?.ownerId).toBeNull();
  });
});
