import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { clampPanelWidth, defaultPanelWidth, GE_CANVAS_MIN, GE_DETAIL_KEY, GE_DETAIL_MIN, GeDivider, geDetailWidth, savedGeDetailWidth, saveGeDetailWidth, MAP_KEEP, PANEL_MIN, PANEL_WIDTH_KEY, PanelResizer, panelMax, panelWidthFor, RESIZE_HINT, savedPanelWidth, savePanelWidth } from "../src/panels/panelResize";

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

describe("goal editor divider (flag dc_bc67e2sw7z)", () => {
  it("renders a vertical separator with the reset hint", () => {
    const html = renderToStaticMarkup(<GeDivider width={420} onResize={() => undefined} />);
    expect(html).toContain('class="ge-divider"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-valuenow="420"');
    expect(html).toContain(RESIZE_HINT);
  });
  it("a drag sets the detail width from the pointer, keeping both minimums", () => {
    // a 1200 px body starting at x=100: the pointer at 700 leaves 600 px to its right
    expect(geDetailWidth(700, 100, 1200)).toBe(600);
    expect(geDetailWidth(1290, 100, 1200)).toBe(GE_DETAIL_MIN);
    expect(geDetailWidth(150, 100, 1200)).toBe(1200 - GE_CANVAS_MIN);
    expect(geDetailWidth(700.6, 100, 1200)).toBe(599);
  });
  it("remembers the width across reloads and a reset forgets it", () => {
    const s = memStore();
    expect(savedGeDetailWidth(s)).toBeNull();
    saveGeDetailWidth(geDetailWidth(700, 100, 1200), s);
    expect(s.m.get(GE_DETAIL_KEY)).toBe("600");
    expect(savedGeDetailWidth(s)).toBe(600);
    saveGeDetailWidth(null, s);
    expect(savedGeDetailWidth(s)).toBeNull();
  });
});
