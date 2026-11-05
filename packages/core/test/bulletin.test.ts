import { describe, expect, it } from "vitest";
import { BULLETIN_PLACE } from "@muster-town/schema";
import { bulletinNotes, cabinetDocs, createUser, postBulletin, takeDownBulletin, TOWN_HALL_ID } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

describe("the bulletin board in the town square (flag dc_52njv3shp8)", () => {
  it("signed-in humans pin notes; everyone reads them newest first; agents can't post", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    const first = postBulletin(world, admin, { title: " Lost umbrella ", body: "Blue, by the fountain." });
    expect(first).toMatchObject({ type: "bulletin", state: "building", buildingId: null, title: "Lost umbrella", authorKind: "user" });
    const second = postBulletin(world, admin, { title: "Meetup", body: "Friday in the square." });
    expect(bulletinNotes(world).map((d) => d.id)).toEqual([second.id, first.id]);
    // agents: not through the dedicated call, not through `write`
    expect(() => postBulletin(world, mei, { title: "x", body: "y" })).toThrow(/for humans/);
    await expect(world.verbs.write(mei, { type: "bulletin", title: "x", body: "y", state: "building" })).rejects.toThrow(/bulletin board/);
    expect(() => postBulletin(world, admin, { title: " ", body: "y" })).toThrow(/title and a body/);
    // it is on no board and in no filing cabinet
    expect(cabinetDocs(world, TOWN_HALL_ID, 50).some((d) => d.type === "bulletin")).toBe(false);
  });

  it("its author or a town admin takes a note down (back to the author's drafts); nobody else", () => {
    const { world, by, admin } = seededWorld();
    const other = world.ops.ensureAvatar(createUser(world, "Ada").user.id);
    const note = postBulletin(world, admin, { title: "Old", body: "stale" });
    expect(() => takeDownBulletin(world, by("Mei"), note.id)).toThrow(/author or a town admin/);
    expect(() => takeDownBulletin(world, other, note.id)).toThrow(/author or a town admin/);
    // a human takes down their own note
    const own = postBulletin(world, other, { title: "Mine", body: "x" });
    expect(takeDownBulletin(world, other, own.id).state).toBe("draft");
    expect(takeDownBulletin(world, admin, note.id).state).toBe("draft");
    expect(bulletinNotes(world)).toEqual([]);
    expect(() => takeDownBulletin(world, admin, note.id)).toThrow(/Only a note on the bulletin board/);
  });

  it("agents see it in `look` as a place in the square", async () => {
    const { world, by } = seededWorld();
    const look = await world.verbs.look(by("Mei"), {});
    expect(look.places).toContainEqual(expect.objectContaining({ id: BULLETIN_PLACE, kind: "bulletin" }));
  });
});
