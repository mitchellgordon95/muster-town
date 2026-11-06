// gr_4csjpgh346 step 3 (kr_sa1gn36ndz): a doc, grant or agent opened from a link opens in the link sheet over whatever is
// open; the side panel it was clicked in stays, and the hash routes still open the same sheet
import { beforeEach, describe, expect, it } from "vitest";
import { openIdLink } from "../src/panels/Markdown";
import { isTopSheet, nextSheetSeq, pushSheet } from "../src/panels/Sheet";
import { routeOf, shownHash } from "../src/route";
import { sheetOf, store } from "../src/state";

describe("links open the link sheet, the side panel stays", () => {
  beforeEach(() => store.set({ panel: { kind: "intray", id: "town-hall" }, sheet: null }));

  it("a doc, a grant and an agent link open as a sheet over the in-tray", () => {
    openIdLink("gr_aaaaaaaaaa");
    expect(store.state.sheet).toEqual({ kind: "grant", id: "gr_aaaaaaaaaa" });
    openIdLink("ag_bbbbbbbbbb");
    expect(store.state.sheet).toEqual({ kind: "agent", id: "ag_bbbbbbbbbb" });
    store.open({ kind: "library", docId: "dc_cccccccccc" });
    expect(store.state.sheet).toEqual({ kind: "doc", id: "dc_cccccccccc" });
    expect(store.state.panel).toEqual({ kind: "intray", id: "town-hall" });
  });

  it("closing the sheet is back on the in-tray", () => {
    store.open({ kind: "grant", id: "gr_aaaaaaaaaa" });
    store.openSheet(null);
    expect(store.state.sheet).toBeNull();
    expect(store.state.panel).toEqual({ kind: "intray", id: "town-hall" });
  });

  it("a meeting, a building or an assignment still opens its side panel", () => {
    openIdLink("mt_dddddddddd");
    expect(store.state.panel).toEqual({ kind: "meeting", id: "mt_dddddddddd" });
    expect(store.state.sheet).toBeNull();
  });

  it("only docs (by id) and grants are sheets among panel refs; the library list and an agent clicked on the map stay panels", () => {
    expect(sheetOf({ kind: "library" })).toBeNull();
    expect(sheetOf({ kind: "agent", id: "ag_bbbbbbbbbb" })).toBeNull();
    expect(sheetOf({ kind: "grant", id: "gr_a" })).toEqual({ kind: "grant", id: "gr_a" });
  });
});

describe("hash routes", () => {
  it("#/doc, #/grant and #/agent open the link sheet; a deck's slide hash is its doc", () => {
    expect(routeOf("#/doc/dc_cccccccccc")).toEqual({ sheet: { kind: "doc", id: "dc_cccccccccc" } });
    expect(routeOf("#/doc/dc_cccccccccc/3")).toEqual({ sheet: { kind: "doc", id: "dc_cccccccccc" } });
    expect(routeOf("#/grant/gr_aaaaaaaaaa")).toEqual({ sheet: { kind: "grant", id: "gr_aaaaaaaaaa" } });
    expect(routeOf("#/agent/ag_bbbbbbbbbb")).toEqual({ sheet: { kind: "agent", id: "ag_bbbbbbbbbb" } });
  });

  it("the other hashes still open their panels", () => {
    expect(routeOf("#/meeting/mt_dddddddddd")).toEqual({ panel: { kind: "meeting", id: "mt_dddddddddd" } });
    expect(routeOf("#/kr/kr_eeeeeeeeee")).toEqual({ panel: { kind: "goals", id: "kr_eeeeeeeeee" } });
    expect(routeOf("#/finance")).toEqual({ panel: { kind: "bank" } });
    expect(routeOf("#/manual/design")).toEqual({ panel: { kind: "manual", id: "design" } });
    expect(routeOf("#/nothing")).toBeNull();
  });

  it("#/building opens a bl_ building and the two un-prefixed ones (the Workshop, the Town Hall)", () => {
    expect(routeOf("#/building/bl_hzjw0z0zlz")).toEqual({ panel: { kind: "building", id: "bl_hzjw0z0zlz" } });
    expect(routeOf("#/building/workshop")).toEqual({ panel: { kind: "building", id: "workshop" } });
    expect(routeOf("#/building/town-hall")).toEqual({ panel: { kind: "building", id: "town-hall" } });
    expect(routeOf("#/building/elsewhere")).toBeNull();
    expect(routeOf("#/meeting/workshop")).toBeNull();
  });

  it("the address bar follows the sheet, then the panel under it once it closes", () => {
    expect(shownHash({ kind: "doc", id: "dc_c" }, { kind: "bank" })).toBe("#/doc/dc_c");
    expect(shownHash({ kind: "agent", id: "ag_b" }, null)).toBe("#/agent/ag_b");
    expect(shownHash(null, { kind: "bank" })).toBe("#/bank");
    expect(shownHash(null, { kind: "intray", id: "town-hall" })).toBe("");
  });
});

describe("stacked sheets", () => {
  it("Esc belongs to the newest sheet: a link sheet over an in-tray item sheet", () => {
    const intray = { seq: nextSheetSeq() }, link = { seq: nextSheetSeq() };
    // effects run child-first: the newer sheet may register before the older one; it is still the top
    const offLink = pushSheet(link);
    const offIntray = pushSheet(intray);
    expect(isTopSheet(link)).toBe(true);
    expect(isTopSheet(intray)).toBe(false);
    offLink();
    expect(isTopSheet(intray)).toBe(true);
    offIntray();
  });
});
