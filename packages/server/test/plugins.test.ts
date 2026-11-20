import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const NOTES = "---\nname: Notes\ndescription: A shared notepad.\nscopes: docs.read, docs.write\n---\n<h1>Notes</h1>";

describe("plugin routes (docs/plugins.md)", () => {
  it("an agent installs a plugin with write; the map shows it; the bridge routes list, read and write as the viewer", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth, by } = s;
    const mei = { authorization: `Bearer ${world.tokens.getOrCreate("agent", by("Mei").id)}` };
    const w = await json(app, "POST", "/api/docs", { headers: mei, body: { type: "plugin", title: "Notes", body: NOTES, state: "building" } });
    expect(w.status).toBe(201);
    const id = w.body.doc.id as string;
    expect((await json(app, "GET", "/api/town")).body.places.find((p: { id: string }) => p.id === `plugin:${id}`)).toMatchObject({ kind: "plugin" });
    const listed = await json(app, "GET", `/api/plugins?buildingId=${by("Mei").homeBuildingId}`);
    expect(listed.body.plugins).toEqual([expect.objectContaining({ id, name: "Notes", tag: "notes", scopes: ["docs.read", "docs.write"] })]);
    // a guest gets the page and the published docs; can't write
    expect((await json(app, "GET", `/api/plugins/${id}`)).body).toMatchObject({ plugin: { id, name: "Notes" }, html: "<h1>Notes</h1>" });
    expect((await json(app, "POST", `/api/plugins/${id}/docs`, { body: { title: "x", body: "y" } })).status).toBe(401);
    // the admin publishes (doc.write_building anywhere), then rewrites
    const made = await json(app, "POST", `/api/plugins/${id}/docs`, { headers: auth, body: { title: "Hello", body: "first", state: "building" } });
    expect(made.status).toBe(201);
    expect(made.body.doc).toMatchObject({ type: "note", tags: ["notes"], state: "building", authorKind: "user" });
    const docId = made.body.doc.id as string;
    expect((await json(app, "POST", `/api/plugins/${id}/docs`, { headers: auth, body: { id: docId, title: "Hello", body: "second", state: "draft" } })).body.doc).toMatchObject({ body: "second", state: "draft" });
    expect((await json(app, "GET", `/api/plugins/${id}/docs`)).body.docs).toEqual([]);
    expect((await json(app, "GET", `/api/plugins/${id}/docs?state=draft`, { headers: auth })).body.docs.map((d: { id: string }) => d.id)).toEqual([docId]);
    expect((await json(app, "GET", `/api/plugins/${id}/docs/${docId}`, { headers: auth })).body.doc.body).toBe("second");
    expect((await json(app, "GET", `/api/plugins/${id}/docs/${docId}`)).status).toBe(404);
    // the plugin doc keeps its revisions
    await json(app, "POST", "/api/docs", { headers: mei, body: { id, type: "plugin", title: "Notes", body: NOTES.replace("<h1>", "<h2>"), state: "building" } });
    expect((await json(app, "GET", `/api/docs/${id}`)).body.revisions.map((r: { body: string }) => r.body)).toEqual([NOTES]);
    expect((await json(app, "GET", "/api/plugins/dc_nope")).status).toBe(404);
  });
});
