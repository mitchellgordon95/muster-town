import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { clampPanelWidth, defaultPanelWidth, MAP_KEEP, PANEL_MIN, PANEL_WIDTH_KEY, PanelResizer, panelMax, panelWidthFor, RESIZE_HINT, savedPanelWidth, savePanelWidth } from "../src/panels/panelResize";

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

describe("side panel resize", () => {
  it("renders a labelled vertical drag handle with the reset hint", () => {
    const html = renderToStaticMarkup(<PanelResizer width={480} onResize={() => undefined} />);
    expect(html).toContain('class="panel-resizer"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-valuenow="480"');
    expect(html).toContain(RESIZE_HINT);
  });
  it("clamps between the min and a max that leaves the map showing", () => {
    expect(clampPanelWidth(100, 1600)).toBe(PANEL_MIN);
    expect(clampPanelWidth(5000, 1600)).toBe(1600 - MAP_KEEP);
    expect(clampPanelWidth(700.4, 1600)).toBe(700);
    expect(panelMax(400)).toBe(PANEL_MIN);
  });
  it("persists the chosen width, survives a reload, and a reset goes back to the default", () => {
    const s = memStore();
    expect(savedPanelWidth(s)).toBeNull();
    expect(panelWidthFor(1600, savedPanelWidth(s))).toBe(defaultPanelWidth(1600));
    savePanelWidth(820, s);
    expect(s.m.get(PANEL_WIDTH_KEY)).toBe("820");
    expect(panelWidthFor(1600, savedPanelWidth(s))).toBe(820);
    // a smaller window clamps the saved width without forgetting it
    expect(panelWidthFor(900, savedPanelWidth(s))).toBe(900 - MAP_KEEP);
    savePanelWidth(null, s);
    expect(s.m.has(PANEL_WIDTH_KEY)).toBe(false);
    expect(panelWidthFor(1600, savedPanelWidth(s))).toBe(500);
    s.setItem(PANEL_WIDTH_KEY, "junk");
    expect(savedPanelWidth(s)).toBeNull();
  });
});
