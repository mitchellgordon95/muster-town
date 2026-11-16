/**
 * The operating manual as a book in the Town Hall (Mitchell, 2026-11-16): a lectern right of the library shelves; using
 * it opens the manual's page (GET /api/operating-manual gives its doc id) as a sheet.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TILE } from "@muster-town/schema";
import { api, getApi } from "../src/api";
import { store } from "../src/state";
import { MockApi } from "../src/mock/server";
import { openOperatingManual, placePanel } from "../src/map/renderer";

describe("the operating manual book", () => {
  beforeAll(async () => { await getApi(); });
  it("sits right of the library shelves in the mock Town Hall, read from the tile below", async () => {
    const town = await new MockApi().town();
    const p = town.places.find((x) => x.id === "operating-manual")!;
    expect(p.kind).toBe("operating-manual");
    const at = (x: number, y: number) => town.grid.tiles[y * town.grid.w + x];
    expect(at(p.pos.x, p.pos.y - 1)).toBe(TILE.BOOK);
    expect(at(p.pos.x - 1, p.pos.y - 1)).toBe(TILE.SHELF);
    // the book is an action (it fetches the manual's id), not a plain panel
    expect(placePanel(p)).toBeNull();
  });
  it("opens the manual's page as a sheet; before anyone wrote one, the library", async () => {
    const mock = new MockApi();
    vi.spyOn(api(), "operatingManual").mockImplementationOnce(() => mock.operatingManual());
    store.openSheet(null);
    openOperatingManual();
    await vi.waitFor(() => expect(store.state.sheet).toEqual({ kind: "doc", id: "dc_op_manual" }));
    store.openSheet(null);
    vi.spyOn(api(), "operatingManual").mockRejectedValueOnce(new Error("not_found"));
    openOperatingManual();
    await vi.waitFor(() => expect(store.state.panel).toEqual({ kind: "library" }));
    expect(store.state.sheet).toBeNull();
  });
});
