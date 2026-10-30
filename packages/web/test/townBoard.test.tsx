import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { store } from "../src/state";
import { MockApi } from "../src/mock/server";
import { TownNoteForm, canPostTownBoard, canUnpublish } from "../src/panels/Places";


const me = (isAdmin: boolean, perms: string[] = []) => ({ user: { id: "us_a", name: "A" }, isAdmin, roles: perms.length ? [{ id: "rl", scope: "building", buildingId: "bl_x", permissions: perms }] : [] });
const as = (m: unknown) => { store.state = { ...store.state, me: m as never }; };
const fyi = (authorId: string) => ({ id: "dc_1", type: "fyi", authorId }) as never;

describe("Town Hall board (Mitchell's flag dc_ym8fjxqjiv)", () => {
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
});
