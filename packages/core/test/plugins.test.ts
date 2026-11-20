import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { TILE } from "@muster-town/schema";
import { createUser, findPath, listPluginDocs, parsePlugin, readPluginDoc, revisionsOf, writePluginDoc } from "../src/index.ts";
import { canEditOwned, ownsDoc, TAG_RE, type PluginManifest } from "../src/plugin-manifest.ts";
import { pluginScreens } from "../src/world/layout.ts";
import { seededWorld } from "./helpers.ts";

const page = "<!doctype html><h1>Notes</h1><script>town.docs.list().then(console.log)</script>";
const plugin = (front: string, html = page) => `---\n${front}\n---\n${html}`;
const NOTES = plugin("name: Notes\ndescription: A shared notepad.\nscopes: docs.read, docs.write\ntag: notes-widget");

describe("plugin manifests (docs/plugins.md)", () => {
  it("reads the frontmatter and the page; defaults docType note, tag from the name, no scopes", () => {
    expect(parsePlugin(NOTES)).toEqual({ manifest: { name: "Notes", description: "A shared notepad.", scopes: ["docs.read", "docs.write"], docType: "note", tag: "notes-widget" }, html: page });
    expect(parsePlugin(plugin("name: \"Blog Desk!\"\ndescription: Posts.")).manifest).toEqual({ name: "Blog Desk!", description: "Posts.", scopes: [], docType: "note", tag: "blog-desk" });
    // write implies read
    expect(parsePlugin(plugin("name: W\ndescription: d\nscopes: [docs.write]\ndocType: article")).manifest).toMatchObject({ scopes: ["docs.read", "docs.write"], docType: "article" });
    expect(parsePlugin(plugin("name: W\ndescription: d\nscopes: docs.write, media.upload")).manifest.scopes).toEqual(["docs.read", "docs.write", "media.upload"]);
  });

  it("refuses what is wrong, saying what", () => {
    expect(() => parsePlugin(page)).toThrow(/frontmatter/);
    expect(() => parsePlugin(plugin("description: d"))).toThrow(/name:/);
    expect(() => parsePlugin(plugin("name: n"))).toThrow(/description:/);
    expect(() => parsePlugin(plugin("name: n\ndescription: d\nscopes: docs.delete"))).toThrow(/Unknown plugin scope "docs.delete"/);
    expect(() => parsePlugin(plugin("name: n\ndescription: d\ndocType: report"))).toThrow(/note or article/);
    expect(() => parsePlugin(plugin("name: n\ndescription: d\ntag: Not_Kebab"))).toThrow(/kebab-case/);
    expect(() => parsePlugin(plugin("name: n\ndescription: d", "  "))).toThrow(/no page/);
  });

  it("property: any printable name gives a kebab-case tag or a clear refusal, never a bad tag", () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !/[\r\n]/.test(s) && s.trim() === s && s.length > 0), (name) => {
      let m: PluginManifest;
      try { m = parsePlugin(plugin(`name: ${name}\ndescription: d`)).manifest; } catch (e) { expect(String(e)).toMatch(/plugin/i); return; }
      expect(TAG_RE.test(m.tag)).toBe(true);
      expect(m.tag.length).toBeLessThanOrEqual(40);
    }));
  });

  it("property: a plugin owns a doc only with its type, its tag and its building; only the author edits a draft", () => {
    const m: PluginManifest = { name: "n", description: "d", scopes: ["docs.read"], docType: "note", tag: "t" };
    const arb = fc.record({ type: fc.constantFrom("note", "article", "report") as fc.Arbitrary<"note" | "article" | "report">, tags: fc.array(fc.constantFrom("t", "u")), buildingId: fc.constantFrom("bl_a", "bl_b", null) });
    fc.assert(fc.property(arb, fc.constantFrom("bl_a", null), (d, pb) => {
      expect(ownsDoc({ buildingId: pb }, m, d)).toBe(d.type === "note" && d.tags.includes("t") && pb !== null && d.buildingId === pb);
    }));
    fc.assert(fc.property(fc.constantFrom("draft", "building", "library") as fc.Arbitrary<"draft" | "building" | "library">, fc.boolean(), fc.boolean(), (state, mine, writes) => {
      const ok = canEditOwned({ authorId: mine ? "me" : "other", state }, "me", writes);
      expect(ok).toBe(mine || (writes && state !== "draft"));
    }));
  });
});

describe("plugins on the map", () => {
  it("property: screens hang on plain back-wall tiles, each over a free plain floor tile, distinct, at most n", () => {
    const { world } = seededWorld();
    const { grid } = world.layout;
    const lab = world.buildings.all().find((b) => b.kind === "lab")!;
    const side = world.layout.side(lab.id)!;
    const taken = new Set(world.layout.places.filter((p) => p.buildingId === lab.id).map((p) => `${p.pos.x},${p.pos.y}`));
    fc.assert(fc.property(fc.integer({ min: 0, max: 30 }), (n) => {
      const s = pluginScreens(grid, lab.lot!, side, taken, n);
      expect(s.length).toBeLessThanOrEqual(n);
      expect(new Set(s.map((x) => `${x.stand.x},${x.stand.y}`)).size).toBe(s.length);
      for (const x of s) {
        expect(grid.tiles[x.wall.y * grid.w + x.wall.x]).toBe(TILE.WALL);
        expect(grid.tiles[x.stand.y * grid.w + x.stand.x]).toBe(TILE.FLOOR);
        expect(taken.has(`${x.stand.x},${x.stand.y}`)).toBe(false);
      }
    }));
  });

  it("a resident installs one in its building: a screen on the back wall, reachable from the door; draft takes it down; a rewrite keeps the old version", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    await expect(world.verbs.write(mei, { type: "plugin", title: "x", body: "<p>no manifest</p>", state: "draft" })).rejects.toThrow(/frontmatter/);
    const { id } = await world.verbs.write(mei, { type: "plugin", title: "Notes", body: NOTES, state: "building" });
    const place = world.layout.requirePlace(`plugin:${id}`);
    expect(place).toMatchObject({ kind: "plugin", buildingId: mei.homeBuildingId, name: "Notes (a plugin)" });
    const { grid } = world.layout;
    const wall = [[0, -1], [0, 1]].map(([dx, dy]) => grid.tiles[(place.pos.y + dy) * grid.w + place.pos.x + dx]);
    expect(wall).toContain(TILE.PLUGIN);
    expect(findPath(grid, world.layout.requirePlace(`door:${mei.homeBuildingId}`).pos, place.pos)).not.toBeNull();
    await world.verbs.write(mei, { id, type: "plugin", title: "Notes", body: NOTES.replace("A shared notepad.", "Notes v2."), state: "building" });
    expect(revisionsOf(world, id).map((r) => r.body)).toEqual([NOTES]);
    // someone who may publish in the building (an admin; a manager's next fork) keeps the installed plugin up to date; a stranger can't
    const ada = world.ops.ensureAvatar(createUser(world, "Ada").user.id);
    await expect(world.verbs.write(ada, { id, type: "plugin", title: "Notes", body: NOTES, state: "building" })).rejects.toThrow(/Not allowed to publish/);
    await expect(world.verbs.write(ada, { id, type: "plugin", title: "Notes", body: NOTES, state: "draft" })).rejects.toThrow(/only update documents you wrote/);
    await world.verbs.write(admin, { id, type: "plugin", title: "Notes", body: NOTES.replace("A shared notepad.", "Notes v3."), state: "building" });
    expect(world.docs.get(id)).toMatchObject({ authorId: mei.id, body: expect.stringContaining("Notes v3.") });
    await world.verbs.write(mei, { id, type: "plugin", title: "Notes", body: NOTES, state: "draft" });
    expect(world.layout.place(`plugin:${id}`)).toBeUndefined();
  });

  it("the bridge's docs: forced type, tag and building; scopes and the viewer's rights apply; a rewrite keeps a revision", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    const { id } = await world.verbs.write(mei, { type: "plugin", title: "Notes", body: NOTES, state: "building" });
    const readOnly = (await world.verbs.write(mei, { type: "plugin", title: "RO", body: plugin("name: RO\ndescription: d\nscopes: docs.read\ntag: notes-widget"), state: "building" })).id;
    const n = writePluginDoc(world, mei, id, { title: "First", body: "hello", state: "building", tags: ["x", "Bad Tag"] });
    expect(n).toMatchObject({ type: "note", buildingId: mei.homeBuildingId, tags: ["notes-widget", "x"], state: "building" });
    expect(() => writePluginDoc(world, mei, readOnly, { title: "No", body: "", state: "draft" })).toThrow(/docs.write scope/);
    // the read-only plugin owns the same tag, so it lists it
    expect(listPluginDocs(world, readOnly, null).map((d) => d.id)).toEqual([n.id]);
    // a stranger (signed-in human, no rights in the building) may draft, not publish, and never rewrite Mei's doc
    const ada = world.ops.ensureAvatar(createUser(world, "Ada").user.id);
    expect(() => writePluginDoc(world, ada, id, { title: "Pub", body: "", state: "building" })).toThrow(/can't publish/);
    const draft = writePluginDoc(world, ada, id, { title: "Mine", body: "secret", state: "draft" });
    expect(() => writePluginDoc(world, ada, id, { id: n.id, title: "Hijack", body: "", state: "draft" })).toThrow(/Only its author/);
    // drafts stay private: Ada sees hers, Mei and guests don't
    expect(listPluginDocs(world, id, world.holderOf(ada).id).map((d) => d.id)).toEqual([draft.id, n.id]);
    expect(listPluginDocs(world, id, mei.id).map((d) => d.id)).toEqual([n.id]);
    expect(listPluginDocs(world, id, null, { state: "draft" })).toEqual([]);
    expect(() => readPluginDoc(world, id, mei.id, draft.id)).toThrow(/no doc/);
    // an admin rewrites a published one; the old body is kept
    const edited = writePluginDoc(world, admin, id, { id: n.id, title: "First, edited", body: "hello again", state: "building" });
    expect(edited.authorId).toBe(mei.id);
    expect(revisionsOf(world, n.id).map((r) => r.body)).toEqual(["hello"]);
    // a doc outside the plugin's set can't be read or rewritten through it
    const other = await world.verbs.write(mei, { type: "note", title: "Plain", body: "x", state: "building" });
    expect(() => readPluginDoc(world, id, mei.id, other.id)).toThrow(/no doc/);
    expect(() => writePluginDoc(world, mei, id, { id: other.id, title: "x", body: "y", state: "building" })).toThrow(/no doc/);
  });
});
