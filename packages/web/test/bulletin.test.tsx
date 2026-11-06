import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BULLETIN_PLACE, TILE } from "@muster-town/schema";
import { getApi } from "../src/api";
import { store } from "../src/state";
import { MockApi } from "../src/mock/server";
import { BulletinForm, canPostBulletin } from "../src/panels/Places";
import { placePanel } from "../src/map/renderer";
import { DocRow } from "../src/panels/DocView";

const as = (m: unknown) => { store.state = { ...store.state, me: m as never }; };

describe("the bulletin board in the town square (Mitchell's flag dc_52njv3shp8)", () => {
  beforeAll(async () => { await getApi(); });
  it("is a place outside the Town Hall in the mock town; E there opens its panel", async () => {
    const town = await new MockApi().town();
    const p = town.places.find((x) => x.id === BULLETIN_PLACE)!;
    expect(p).toMatchObject({ kind: "bulletin", buildingId: null });
    expect(town.grid.tiles[(p.pos.y - 1) * town.grid.w + p.pos.x]).toBe(TILE.BULLETIN);
    expect(placePanel(p)).toEqual({ kind: "bulletin" });
  });
  it("the post form shows only to a signed-in human", () => {
    as(null);
    expect(canPostBulletin()).toBe(false);
    as({ user: { id: "us_a", name: "A" }, isAdmin: false, roles: [] });
    expect(canPostBulletin()).toBe(true);
    const html = renderToStaticMarkup(<BulletinForm onPosted={() => {}} />);
    expect(html).toContain("Post a note");
    expect(html).toContain("Pin it");
  });
  it("mock: a pinned note is listed newest first; taking it down removes it", async () => {
    const api = new MockApi();
    const a = await api.postBulletin({ title: "First", body: "x" });
    const b = await api.postBulletin({ title: "Second", body: "y" });
    expect((await api.bulletin()).map((d) => d.id).slice(0, 2)).toEqual([b.id, a.id]);
    await api.takeDownBulletin(a.id);
    expect((await api.bulletin()).map((d) => d.id)).not.toContain(a.id);
    await expect(api.takeDownBulletin(a.id)).rejects.toThrow(/bulletin board/);
    await expect(api.postBulletin({ title: " ", body: "y" })).rejects.toThrow(/title and a body/);
  });
  it("mock: read / unread for the signed-in human (flag dc_04q4h8s229): others' notes start unread, own notes read; read one, then all", async () => {
    const api = new MockApi();
    const own = await api.postBulletin({ title: "Mine", body: "x" });
    const b0 = await api.bulletinBoard();
    expect(b0.docs.find((d) => d.id === own.id)?.unread).toBe(false);
    expect(b0.docs.find((d) => d.id === "dc_bulletin_picnic")?.unread).toBe(true);
    expect(b0.unread).toBe(1);
    expect(await api.readBulletin("dc_bulletin_picnic")).toBe(0);
    expect((await api.bulletinBoard()).docs.every((d) => !d.unread)).toBe(true);
    expect(await api.readBulletin("all")).toBe(0);
  });
  it("an unread row shows a red \"new\" mark; a read one doesn't", () => {
    const d = { id: "dc_x", type: "bulletin", state: "building", title: "Hi", body: "", authorId: "us_a", authorKind: "user", buildingId: null, provenance: { sourceIds: [], urls: [] }, tags: [], createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z" } as never;
    expect(renderToStaticMarkup(<DocRow doc={d} onOpen={() => {}} unread />)).toContain(">new<");
    expect(renderToStaticMarkup(<DocRow doc={d} onOpen={() => {}} />)).not.toContain(">new<");
  });
});
