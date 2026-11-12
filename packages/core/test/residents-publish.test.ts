/**
 * Residents publish (gr_2r17x8egrc step 2): an agent whose home building is a building files docs in that building's
 * filing cabinet (state "building") without doc.write_building; the board (fyi) stays the manager's, forks' and admins'.
 */
import { describe, expect, it } from "vitest";
import { createBuilding, townRoleId } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

function setup() {
  const s = seededWorld();
  const { world } = s;
  const owner = world.ops.createUser("Owner").user;
  world.permissions.grant({ kind: "user", id: owner.id }, townRoleId("member"));
  const v = world.ops.registerVisitor(owner.id, { name: "Vee", buildingId: "carbon-cycle" }).agent;
  const other = createBuilding(world, { name: "Elsewhere", headcount: 2 }, null, { starterResidents: true }).id;
  return { ...s, v, other };
}

describe("residents publish to their own building's filing cabinet", () => {
  it("a visitor registered in a building publishes a note there; search finds it with state building", async () => {
    const { world, v, by } = setup();
    expect(world.permissions.can(v, "doc.write_building", "carbon-cycle")).toBe(false);
    const r = await world.verbs.write(v, { type: "note", title: "Vee's zebra note", body: "zebra findings", state: "building" });
    expect(r.state).toBe("building");
    expect(world.docs.get(r.id)!.buildingId).toBe("carbon-cycle");
    const hits = (await world.verbs.search(by("Ravi"), { query: "zebra" })).results;
    expect(hits.find((d) => d.id === r.id)).toMatchObject({ state: "building" });
    // a draft published later goes the same way
    const d = await world.verbs.write(v, { type: "article", title: "Draft", body: "quokka", state: "draft" });
    expect((await world.verbs.write(v, { id: d.id, type: "article", title: "Draft", body: "quokka", state: "building" })).state).toBe("building");
  });

  it("the same visitor cannot publish to another building, cannot post an fyi, and a draft stays private", async () => {
    const { world, v, other, by } = setup();
    world.agents.patch(v.id, { buildingId: other });
    await expect(world.verbs.write(world.agents.require(v.id), { type: "note", title: "Away", body: "x", state: "building" })).rejects.toThrow(/own building's filing cabinet/);
    world.agents.patch(v.id, { buildingId: "carbon-cycle" });
    const me = world.agents.require(v.id);
    await expect(world.verbs.write(me, { type: "fyi", title: "FYI", body: "x", state: "building" })).rejects.toThrow(/post FYIs/);
    await expect(world.verbs.write(me, { type: "fyi", title: "FYI", body: "x", state: "building", buildingId: "town-hall" })).rejects.toThrow(/Town Hall board/);
    await expect(world.verbs.write(me, { type: "policy", title: "Rule", body: "x", state: "building" })).rejects.toThrow(/humans only/);
    const draft = await world.verbs.write(me, { type: "note", title: "Secret wombat", body: "wombat", state: "draft" });
    expect(draft.state).toBe("draft");
    expect((await world.verbs.search(by("Ravi"), { query: "wombat" })).results.map((d) => d.id)).not.toContain(draft.id);
  });

  it("a visitor with no home building publishes nowhere this way", async () => {
    const { world } = setup();
    const owner = world.ops.createUser("Owner2").user;
    world.permissions.grant({ kind: "user", id: owner.id }, townRoleId("member"));
    const bench = world.ops.registerVisitor(owner.id, { name: "Benchy" }).agent;
    world.agents.patch(bench.id, { buildingId: "carbon-cycle" });
    await expect(world.verbs.write(world.agents.require(bench.id), { type: "note", title: "N", body: "x", state: "building" })).rejects.toThrow(/register in a building first/);
  });

  it("the Secretary files a note in the Town Hall's filing cabinet", async () => {
    const { world } = setup();
    const sec = world.secretary.ensure()!;
    const r = await world.verbs.write(sec, { type: "note", title: "Slate note", body: "x", state: "building" });
    expect(world.docs.get(r.id)).toMatchObject({ state: "building", buildingId: "town-hall" });
  });
});
