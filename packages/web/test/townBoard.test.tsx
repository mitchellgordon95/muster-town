import { beforeAll, describe, expect, it } from "vitest";
import { getApi } from "../src/api";
import { renderToStaticMarkup } from "react-dom/server";
import { store } from "../src/state";
import { MockApi } from "../src/mock/server";
import { BoardNoteRow, TownNoteForm, canEditBoardNote, canPostTownBoard, canUnpublish } from "../src/panels/Places";


const me = (isAdmin: boolean, perms: string[] = []) => ({ user: { id: "us_a", name: "A" }, isAdmin, roles: perms.length ? [{ id: "rl", scope: "building", buildingId: "bl_x", permissions: perms }] : [] });
const as = (m: unknown) => { store.state = { ...store.state, me: m as never }; };
const fyi = (authorId: string) => ({ id: "dc_1", type: "fyi", authorId }) as never;

describe("Town Hall board (Mitchell's flag dc_ym8fjxqjiv)", () => {
  beforeAll(async () => { await getApi(); });
  it("the post form is for admins and managers of any building; taking one off is for its author or an admin", () => {
    as(me(true));
    expect(canPostTownBoard()).toBe(true);
    expect(canUnpublish(fyi("ag_other"))).toBe(true);
    as(me(false, ["building.manage"]));
    expect(canPostTownBoard()).toBe(true);
    expect(canUnpublish(fyi("us_a"))).toBe(true);
    expect(canUnpublish(fyi("ag_other"))).toBe(false);
    as(me(false, ["doc.write_building"]));
    expect(canPostTownBoard()).toBe(false);
    as(null);
    expect(canPostTownBoard()).toBe(false);
    expect(canUnpublish(fyi("us_a"))).toBe(false);
    const html = renderToStaticMarkup(<TownNoteForm buildingId="town-hall" onPosted={() => {}} />);
    expect(html).toContain("Post a town-wide note");
    expect(html).toContain("Post to every building");
  });
  it("mock: a posted town-wide note shows on every building's board; taking it off removes it", async () => {
    const api = new MockApi();
    const town = await api.town();
    const hall = town.buildings.find((b) => b.kind === "town-hall")!;
    const lab = town.buildings.find((b) => b.kind !== "town-hall")!;
    const d = await api.writeDoc({ type: "fyi", state: "building", buildingId: hall.id, title: "Hello town", body: "x" });
    expect((await api.board(hall.id)).docs.map((x) => x.id)).toContain(d.id);
    expect((await api.board(lab.id)).docs.find((x) => x.id === d.id)).toMatchObject({ townWide: true });
    await api.unpublish(d.id);
    expect((await api.board(lab.id)).docs.map((x) => x.id)).not.toContain(d.id);
    await expect(api.unpublish(d.id)).rejects.toThrow(/Town Hall board/);
  });
  it("board notes get Edit for their author, an admin or the building's manager; guests see none (flag dc_4itg2gxfqf)", () => {
    const note = { id: "dc_2", type: "fyi", authorId: "ag_other", buildingId: "bl_x", title: "Lab rule", body: "x", state: "building", tags: [], provenance: { sourceIds: [], urls: [] }, createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:00Z" } as never;
    const html = () => renderToStaticMarkup(<BoardNoteRow doc={note} onOpen={() => {}} onEdited={() => {}} />);
    as(null);
    expect(canEditBoardNote(note)).toBe(false);
    expect(html()).not.toContain(">Edit<");
    as(me(false, ["doc.write_building"]));
    expect(canEditBoardNote(note)).toBe(false);
    expect(html()).not.toContain(">Edit<");
    as(me(false, ["building.manage"]));
    expect(canEditBoardNote(note)).toBe(true);
    expect(html()).toContain(">Edit<");
    expect(canEditBoardNote({ ...(note as object), buildingId: "town-hall" } as never)).toBe(false);
    expect(canEditBoardNote({ ...(note as object), authorId: "us_a", buildingId: "town-hall" } as never)).toBe(true);
    as(me(true));
    expect(canEditBoardNote({ ...(note as object), buildingId: "town-hall" } as never)).toBe(true);
    // no onEdited (not a board): no button
    expect(renderToStaticMarkup(<BoardNoteRow doc={note} onOpen={() => {}} />)).not.toContain(">Edit<");
  });
  it("mock: editing a board note changes its title and body on the board", async () => {
    const api = new MockApi();
    const town = await api.town();
    const lab = town.buildings.find((b) => b.kind !== "town-hall")!;
    const d = await api.writeDoc({ type: "fyi", state: "building", buildingId: lab.id, title: "Old", body: "old" });
    await api.editBoardNote(d.id, { title: "New", body: "new body" });
    expect((await api.board(lab.id)).docs.find((x) => x.id === d.id)).toMatchObject({ title: "New", body: "new body" });
    await expect(api.editBoardNote(d.id, { title: "New", body: " " })).rejects.toThrow(/title and a body/);
  });
});
