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
