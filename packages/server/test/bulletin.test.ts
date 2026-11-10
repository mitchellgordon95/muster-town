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

  it("tracks read / unread per signed-in human (flag dc_04q4h8s229): a note is unread until opened; your own notes are read; guests and agents get no flags", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth, by } = s;
    const ada = { authorization: `Bearer ${world.ops.createUser("Ada").token}` };
    const agent = { authorization: `Bearer ${world.tokens.getOrCreate("agent", by("Mei").id)}` };
    const a = (await json(app, "POST", "/api/bulletin", { headers: auth, body: { title: "Picnic", body: "Saturday." } })).body.doc.id as string;
    const b = (await json(app, "POST", "/api/bulletin", { headers: auth, body: { title: "Lost key", body: "Blue ribbon." } })).body.doc.id as string;
    const flags = (r: { body: { docs: { id: string; unread?: boolean }[] } }) => Object.fromEntries(r.body.docs.map((d) => [d.id, d.unread]));

    // the author: both read; Ada: both unread
    const mine = await json(app, "GET", "/api/bulletin", { headers: auth });
    expect(mine.body.unread).toBe(0);
    expect(flags(mine)).toEqual({ [a]: false, [b]: false });
    const hers = await json(app, "GET", "/api/bulletin", { headers: ada });
    expect(hers.body.unread).toBe(2);
    expect(flags(hers)).toEqual({ [a]: true, [b]: true });
    // a guest and an agent: the notes, no flags, no count
    for (const headers of [undefined, agent]) {
      const r = await json(app, "GET", "/api/bulletin", { headers });
      expect(r.body.unread).toBeUndefined();
      expect(r.body.docs.map((d: { unread?: boolean }) => d.unread)).toEqual([undefined, undefined]);
    }
    // opening one marks it read for Ada only; twice is fine
    expect((await json(app, "POST", `/api/bulletin/${a}/read`, { headers: ada })).body).toEqual({ unread: 1 });
    expect((await json(app, "POST", `/api/bulletin/${a}/read`, { headers: ada })).body).toEqual({ unread: 1 });
    expect(flags(await json(app, "GET", "/api/bulletin", { headers: ada }))).toEqual({ [a]: false, [b]: true });
    // guests and agents can't mark; a doc that isn't a note is refused
    expect((await json(app, "POST", `/api/bulletin/${b}/read`)).status).toBe(401);
    expect((await json(app, "POST", `/api/bulletin/${b}/read`, { headers: agent })).status).toBe(403);
    const fyi = world.docs.first("type != 'bulletin'")!;
    expect((await json(app, "POST", `/api/bulletin/${fyi.id}/read`, { headers: ada })).status).toBe(400);
    // taken down: off the count, but the read stays (the rule is per note id: pinned again, it is still read)
    await json(app, "POST", `/api/bulletin/${a}/take-down`, { headers: auth });
    expect((await json(app, "GET", "/api/bulletin", { headers: ada })).body.unread).toBe(1);
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM bulletin_reads WHERE docId = ?").get(a)).toEqual({ n: 1 });
    // "all" marks every note on the board
    expect((await json(app, "POST", "/api/bulletin/all/read", { headers: ada })).body).toEqual({ unread: 0 });
  });
});
