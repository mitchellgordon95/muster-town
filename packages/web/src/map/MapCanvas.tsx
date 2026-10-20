import { useEffect, useRef } from "react";
import { store } from "../state";
import { MapRenderer, type Target } from "./renderer";

const MOVE_KEYS = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

export function typing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT" || el.isContentEditable);
}

let current: MapRenderer | null = null;
export const mapRenderer = () => current;

export function MapCanvas(props: { panelInset: number; onTarget: (t: Target | null) => void; onMove: (x: number, y: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cbs = useRef(props);
  cbs.current = props;

  useEffect(() => {
    const r = new MapRenderer(ref.current!);
    current = r;
    store.walkTo = (placeId, panel) => r.walkToPlace(placeId, panel);
    r.onTarget = (t) => cbs.current.onTarget(t);
    r.onMove = (x, y) => cbs.current.onMove(x, y);
    const down = (e: KeyboardEvent) => {
      if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (MOVE_KEYS.has(k)) { r.keyDown(k); e.preventDefault(); }
      else if (k === "e" && !e.repeat) { const t = r.currentTarget; if (t) { store.open(t.panel); e.preventDefault(); } }
      else if (k === "tab" && r.cycleTarget(e.shiftKey ? -1 : 1)) e.preventDefault();
      else if (k === "-" || k === "_") r.zoom = Math.max(2, r.zoom - 1);
      else if (k === "=" || k === "+") r.zoom = Math.min(5, r.zoom + 1);
    };
    const up = (e: KeyboardEvent) => r.keyUp(e.key.toLowerCase());
    const blur = () => r.clearKeys();
    const focusin = () => { if (typing()) r.clearKeys(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    document.addEventListener("focusin", focusin);
    return () => {
      r.destroy(); current = null;
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      document.removeEventListener("focusin", focusin);
    };
  }, []);

  useEffect(() => { if (current) current.panelInset = props.panelInset; }, [props.panelInset]);

  const local = (e: React.MouseEvent) => {
    const b = ref.current!.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  return (
    <canvas
      ref={ref}
      className="map"
      onMouseMove={(e) => {
        const r = current; if (!r) return;
        const p = local(e);
        const id = r.hit(p.x, p.y);
        r.hoverId = id;
        ref.current!.style.cursor = id ? "pointer" : "default";
      }}
      onMouseLeave={() => { if (current) current.hoverId = null; }}
      onClick={(e) => {
        (document.activeElement as HTMLElement | null)?.blur();
        const r = current; if (!r) return;
        const p = local(e);
        const id = r.hit(p.x, p.y);
        if (id) store.open({ kind: "agent", id });
      }}
    />
  );
}
