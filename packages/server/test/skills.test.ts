import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const SKILL = "---\nname: mitchell-style\ndescription: Use in every session: how Mitchell likes work done.\n---\nShip small, commit to main.\n";

describe("skills routes", () => {
  it("a human writes a skill with files, it stays private as a draft, is promoted, pinned town-wide and unpinned", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth } = s;
    const created = await json(app, "POST", "/api/docs", { headers: auth, body: { type: "skill", title: "x", body: SKILL, files: [{ path: "scripts/check.sh", content: "echo ok\n" }] } });
    expect(created.status).toBe(201);
    const id = created.body.doc.id as string;
    expect(created.body.doc.title).toBe("mitchell-style");
    // bad SKILL.md is a 400
    expect((await json(app, "POST", "/api/docs", { headers: auth, body: { type: "skill", title: "x", body: "no frontmatter" } })).status).toBe(400);

    // drafts: only the author sees them
    expect((await json(app, "GET", "/api/skills")).body.skills).toHaveLength(0);
    expect((await json(app, "GET", `/api/skills/${id}`)).status).toBe(404);
    const listed = await json(app, "GET", "/api/skills", { headers: auth });
    expect(listed.body.skills.map((k: { name: string }) => k.name)).toEqual(["mitchell-style"]);
    const bundle = await json(app, "GET", `/api/skills/${id}/bundle`, { headers: auth });
    expect(bundle.body.files.map((f: { path: string }) => f.path)).toEqual(["SKILL.md", "scripts/check.sh"]);
    const raw = await app.inject({ method: "GET", url: `/api/skills/${id}/files/scripts/check.sh`, headers: auth });
    expect(raw.statusCode).toBe(200);
    expect(raw.body).toBe("echo ok\n");

    // town pin needs a library skill; then it reaches every resident's prompt
    expect((await json(app, "POST", `/api/skills/${id}/pins`, { headers: auth, body: { scope: "town", mode: "always" } })).status).toBe(400);
    expect((await json(app, "POST", `/api/docs/${id}/promote`, { headers: auth, body: { state: "library" } })).status).toBe(200);
    const pinned = await json(app, "POST", `/api/skills/${id}/pins`, { headers: auth, body: { scope: "town", mode: "always" } });
    expect(pinned.status).toBe(201);
    const resident = world.agents.first("kind = 'resident'")!;
    expect(world.skills.forAgent(resident.id).map((k) => [k.md.name, k.mode])).toEqual([["mitchell-style", "always"]]);
    expect((await json(app, "GET", `/api/skills/${id}`)).body.skill.pins).toHaveLength(1);

    // a resident can't remove the town pin; the admin can
    const agentAuth = { authorization: `Bearer ${world.tokens.getOrCreate("agent", resident.id)}` };
    expect((await json(app, "DELETE", `/api/skill-pins/${pinned.body.pin.id}`, { headers: agentAuth })).status).toBe(403);
    expect((await json(app, "DELETE", `/api/skill-pins/${pinned.body.pin.id}`, { headers: auth })).body).toEqual({ removed: true });
    expect(world.skills.forAgent(resident.id)).toEqual([]);
  });
});
