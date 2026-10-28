import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MockApi } from "../src/mock/server";
import { FORKS_HINT, ForksField } from "../src/panels/BuildingPanel";

describe("Budget mode: the Forks toggle", () => {
  it("renders on, off and still-loading, with its one line of help", () => {
    const on = renderToStaticMarkup(<ForksField on={true} onChange={() => undefined} />);
    expect(on).toContain("Forks");
    expect(on).toContain(FORKS_HINT);
    expect(on).toMatch(/checked=""/);
    expect(on).toContain("> on");
    const off = renderToStaticMarkup(<ForksField on={false} onChange={() => undefined} />);
    expect(off).not.toMatch(/checked=""/);
    expect(off).toContain("> off");
    expect(renderToStaticMarkup(<ForksField on={null} onChange={() => undefined} />)).toMatch(/disabled=""/);
  });
  it("the same PATCH flips the flag and GET /api/buildings/:id reads it back", async () => {
    const api = new MockApi();
    expect((await api.building("bl_carbon")).forks).toBe(false);
    expect((await api.updateBuilding("bl_carbon", { forks: true })).forks).toBe(true);
    expect((await api.building("bl_carbon")).forks).toBe(true);
    await api.updateBuilding("bl_carbon", { forks: false });
    expect((await api.building("bl_carbon")).forks).toBe(false);
  });
});
