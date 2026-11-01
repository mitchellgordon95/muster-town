/**
 * The side panel's width: a drag handle on its inner (left) edge, clamped between PANEL_MIN and a max that
 * leaves some map showing, saved in localStorage so it survives reloads. Double-click (or Home) resets it to
 * the default, which follows the window size. Text in the panel reflows at any width (no clipping).
 */
import { useEffect, useState, type KeyboardEvent, type PointerEvent } from "react";

export const PANEL_WIDTH_KEY = "musterTown.panel.width";
export const PANEL_MIN = 320;
/** the map keeps at least this much room on the left of the panel */
export const MAP_KEEP = 240;
const PANEL_MAX_ABS = 1400;
const KEY_STEP = 40;

/** the width the panel opens at when nobody has resized it: about a third of the window */
export function defaultPanelWidth(vw: number): number { return Math.round(Math.min(500, Math.max(360, vw * 0.36))); }
export function panelMax(vw: number): number { return Math.max(PANEL_MIN, Math.min(PANEL_MAX_ABS, vw - MAP_KEEP)); }
export function clampPanelWidth(w: number, vw: number): number { return Math.round(Math.min(panelMax(vw), Math.max(PANEL_MIN, w))); }

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function storage(): Store | null { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } }

/** the saved width, or null when there is none (or it isn't a number) */
export function savedPanelWidth(s: Store | null = storage()): number | null {
  try { const v = Number(s?.getItem(PANEL_WIDTH_KEY)); return v > 0 ? v : null; } catch { return null; }
}
export function savePanelWidth(w: number | null, s: Store | null = storage()): void {
  try { if (w === null) s?.removeItem(PANEL_WIDTH_KEY); else s?.setItem(PANEL_WIDTH_KEY, String(Math.round(w))); } catch { /* private window */ }
}
/** what the panel shows: the saved width clamped to this window, else the default */
export function panelWidthFor(vw: number, saved: number | null): number { return saved === null ? defaultPanelWidth(vw) : clampPanelWidth(saved, vw); }

/**
 * Fullscreen (a deck's `f`): the panel at its maximum width until it is turned off, without touching the saved width.
 * Components ask for it with setPanelFull; the app's usePanelWidth follows.
 */
const FULL_EVENT = "musterTown:panel-full";
let panelFull = false;
export const isPanelFull = () => panelFull;
export function setPanelFull(on: boolean) {
  if (on === panelFull) return;
  panelFull = on;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(FULL_EVENT));
}

/** width state for the app: follows window resizes, persists what the handle sets, `null` resets; fullscreen wins */
export function usePanelWidth(): [number, (w: number | null) => void] {
  const [saved, setSaved] = useState(() => savedPanelWidth());
  const [vw, setVw] = useState(() => window.innerWidth);
  const [full, setFull] = useState(panelFull);
  useEffect(() => {
    const r = () => setVw(window.innerWidth);
    const f = () => setFull(panelFull);
    window.addEventListener("resize", r); window.addEventListener(FULL_EVENT, f);
    return () => { window.removeEventListener("resize", r); window.removeEventListener(FULL_EVENT, f); };
  }, []);
  const set = (w: number | null) => {
    const v = w === null ? null : clampPanelWidth(w, window.innerWidth);
    setPanelFull(false); // dragging the handle leaves fullscreen
    savePanelWidth(v); setSaved(v);
  };
  return [full ? panelMax(vw) : panelWidthFor(vw, saved), set];
}

export const RESIZE_HINT = "Drag to resize · double-click to reset";

/** the drag handle; the panel is right-anchored, so its width is the window width minus the pointer's x */
export function PanelResizer({ width, onResize }: { width: number; onResize: (w: number | null) => void }) {
  const [dragging, setDragging] = useState(false);
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(true);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => { if (dragging) onResize(window.innerWidth - e.clientX); };
  const up = (e: PointerEvent<HTMLDivElement>) => { e.currentTarget.releasePointerCapture?.(e.pointerId); setDragging(false); };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") onResize(width + KEY_STEP);
    else if (e.key === "ArrowRight") onResize(width - KEY_STEP);
    else if (e.key === "Home") onResize(null);
    else return;
    e.preventDefault();
  };
  return (
    <div className={dragging ? "panel-resizer dragging" : "panel-resizer"} role="separator" aria-orientation="vertical"
      aria-label="Resize panel" aria-valuenow={width} aria-valuemin={PANEL_MIN} tabIndex={0} title={RESIZE_HINT}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onDoubleClick={() => onResize(null)} onKeyDown={key} />
  );
}

/**
 * The goal tree editor's divider (flag dc_bc67e2sw7z): drag the line between the canvas and the detail pane. The detail
 * keeps at least GE_DETAIL_MIN, the canvas at least GE_CANVAS_MIN; the width is saved like the side panel's and the
 * CSS clamps it again to whatever the sheet is now (styles.css .ge-body.sized). Double-click (or Home) goes back to 60/40.
 */
export const GE_DETAIL_KEY = "musterTown.goalEditor.detailWidth";
export const GE_DETAIL_MIN = 320;
export const GE_CANVAS_MIN = 360;
/** the detail pane's width for a pointer at x in a body spanning [left, left + width] */
export function geDetailWidth(pointerX: number, bodyLeft: number, bodyWidth: number): number {
  return Math.round(Math.max(GE_DETAIL_MIN, Math.min(bodyWidth - GE_CANVAS_MIN, bodyLeft + bodyWidth - pointerX)));
}
export function savedGeDetailWidth(s: Store | null = storage()): number | null {
  try { const v = Number(s?.getItem(GE_DETAIL_KEY)); return v > 0 ? v : null; } catch { return null; }
}
export function saveGeDetailWidth(w: number | null, s: Store | null = storage()): void {
  try { if (w === null) s?.removeItem(GE_DETAIL_KEY); else s?.setItem(GE_DETAIL_KEY, String(Math.round(w))); } catch { /* private window */ }
}
export function useGeDetailWidth(): [number | null, (w: number | null) => void] {
  const [w, setW] = useState(() => savedGeDetailWidth());
  return [w, (v) => { saveGeDetailWidth(v); setW(v); }];
}

/** the handle; it sits in the grid's zero-width middle column of .ge-body, so the body is its parent */
export function GeDivider({ width, onResize }: { width: number | null; onResize: (w: number | null) => void }) {
  const [dragging, setDragging] = useState(false);
  const body = (el: HTMLElement) => el.parentElement?.getBoundingClientRect() ?? { left: 0, width: window.innerWidth };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(true);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const r = body(e.currentTarget);
    onResize(geDetailWidth(e.clientX, r.left, r.width));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => { e.currentTarget.releasePointerCapture?.(e.pointerId); setDragging(false); };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const r = body(e.currentTarget);
    const now = width ?? Math.round(r.width * 0.4);
    if (e.key === "ArrowLeft") onResize(geDetailWidth(r.left + r.width - now - KEY_STEP, r.left, r.width));
    else if (e.key === "ArrowRight") onResize(geDetailWidth(r.left + r.width - now + KEY_STEP, r.left, r.width));
    else if (e.key === "Home") onResize(null);
    else return;
    e.preventDefault();
  };
  return (
    <div className={dragging ? "ge-divider dragging" : "ge-divider"} role="separator" aria-orientation="vertical"
      aria-label="Resize the goal detail" aria-valuenow={width ?? undefined} aria-valuemin={GE_DETAIL_MIN} tabIndex={0} title={RESIZE_HINT}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onDoubleClick={() => onResize(null)} onKeyDown={key} />
  );
}
