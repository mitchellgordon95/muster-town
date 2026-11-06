// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Doc } from "@muster-town/schema";
import { getApi } from "../src/api";
import { MockApi } from "../src/mock/server";
import { knownNames } from "../src/names";
import { store } from "../src/state";
import { DocRow, DocView } from "../src/panels/DocView";

// A retired fork is not in the snapshot: its doc's byline reads its name (from GET /api/docs/:id's `author`, or the
// lazy agent lookup), never "by ag_…" (finding dc_0mdearrlgy, live dc_dw0tdr0a6k).
describe("a retired fork's doc shows its name, not its id", () => {
  let doc: Doc;
  beforeAll(async () => {
    await getApi();
    const docs = await new MockApi().docs({ limit: 5 });
    doc = { ...docs[0], authorId: "ag_retiredfork1" };
    expect(store.state.agents[doc.authorId]).toBeUndefined();
  });
  it("the store's names are the map the api client fills", () => {
    expect(store.names).toBe(knownNames);
  });
  it("the doc view and its list row read the known name", () => {
    knownNames.set("ag_retiredfork1", "Teo 1");
    const view = renderToStaticMarkup(<DocView doc={doc} />);
    expect(view).toMatch(/by <b[^>]*>Teo 1<\/b>/);
    expect(view).not.toContain(">ag_retiredfork1<");
    expect(renderToStaticMarkup(<DocRow doc={doc} onOpen={() => {}} />)).toContain("Teo 1 · ");
  });
});
