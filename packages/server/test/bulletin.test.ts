import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe("the bulletin board in the town square (flag dc_52njv3shp8)", () => {
  it("anyone reads it; a signed-in human pins a note (not a guest, not an agent); its author or an admin takes it down", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth, by } = s;
    const agent = { authorization: `Bearer ${world.tokens.getOrCreate("agent", by("Mei").id)}` };
    const note = { title: "Picnic", body: "Saturday by the fountain." };

    expect((await json(app, "POST", "/api/bulletin", { body: note })).status).toBe(401);
    expect((await json(app, "POST", "/api/bulletin", { headers: agent, body: note })).status).toBe(403);
    expect((await json(app, "POST", "/api/bulletin", { headers: auth, body: { title: " ", body: "x" } })).status).toBe(400);
    const posted = await json(app, "POST", "/api/bulletin", { headers: auth, body: note });
    expect(posted.status).toBe(201);
    expect(posted.body.doc).toMatchObject({ type: "bulletin", state: "building", buildingId: null, title: "Picnic", authorKind: "user" });
    const id = posted.body.doc.id as string;

    // a guest reads it
    expect((await json(app, "GET", "/api/bulletin")).body.docs.map((d: { id: string }) => d.id)).toEqual([id]);
    // an agent can't take it down; the author (here the admin) can
    expect((await json(app, "POST", `/api/bulletin/${id}/take-down`, { headers: agent })).status).toBe(403);
    expect((await json(app, "POST", `/api/bulletin/${id}/take-down`, { headers: auth })).body.doc.state).toBe("draft");
    expect((await json(app, "GET", "/api/bulletin")).body.docs).toEqual([]);
    // the place is on the map
    expect((await json(app, "GET", "/api/town")).body.places.find((p: { id: string }) => p.id === "bulletin:town")).toMatchObject({ kind: "bulletin" });
  });
});
