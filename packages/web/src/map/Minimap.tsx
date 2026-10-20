/**
 * The minimap (bottom left): the town zoomed out through the shared overview renderer. It follows you; drag to pan
 * elsewhere, scroll to zoom, click to quick-walk there (◎ snaps back to you). Hidden while the Bank's town map or a
 * layout edit has the main view.
 */
import { useEffect, useRef, useState } from "react";
import { useTown } from "../state";
import { mapRenderer } from "./MapCanvas";
import { layoutEdit } from "./layoutEdit";
import { STATUS_COLOR } from "./overlay";
import { drawOverview, OverviewCam, type OverviewDot } from "./overview";
import { T } from "./sprites";

const W = 232, H = 164;
/** how far in the minimap starts (× the whole-town fit), and its zoom range */
const START = 1.25, MIN = 1, MAX = 6;
/** a press that moves less than this (CSS px) is a click, not a pan */
const DRAG_PX = 4;

export function Minimap() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [follow, setFollow] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [label, setLabel] = useState<string | null>(null);
  const ready = useTown((s) => !!s.grid);
  const st = useRef({ cam: new OverviewCam(W, H), mult: START, follow: true, hover: null as { x: number; y: number } | null, press: null as { x: number; y: number; cx: number; cy: number; moved: boolean } | null });

  useEffect(() => { st.current.follow = follow; }, [follow]);

  useEffect(() => {
    let raf = 0, wasHidden = false;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const r = mapRenderer(), w = r?.town, c = ref.current;
      const hide = !w || !c || r.overview() || !!layoutEdit.draft;
      if (hide !== wasHidden) { wasHidden = hide; setHidden(hide); }
      if (hide) return;
      const s = st.current, cam = s.cam, ww = w.w * T, wh = w.h * T;
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== W * dpr) { c.width = W * dpr; c.height = H * dpr; }
      cam.z = cam.fit(ww, wh) * s.mult;
      if (s.follow) {
        const me = r.mePos;
        cam.cx += (me.x - cam.cx) * 0.2; cam.cy += (me.y - cam.cy) * 0.2;
      }
      cam.clamp(ww, wh);
      const g = c.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const dots: OverviewDot[] = r.others().map((o) => ({ x: o.x, y: o.y, color: STATUS_COLOR[o.status] ?? "#9a9db3" }));
      dots.push({ ...r.mePos, color: "#ffffff", me: true });
      const hv = s.hover && !s.press?.moved ? { ...s.hover, building: w.buildingAt(s.hover.x, s.hover.y) } : null;
      drawOverview(g, w, cam, { dots, frame: r.viewFrame(), hover: hv, labelMinPx: 50 });
      // where an auto-walk is headed
      const end = r.routeEnd;
      if (end) {
        const p = cam.toScreen(end.x * T + T / 2, end.y * T + T / 2);
        g.strokeStyle = "#ffd34d"; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(p.x - 4, p.y - 4); g.lineTo(p.x + 4, p.y + 4); g.moveTo(p.x + 4, p.y - 4); g.lineTo(p.x - 4, p.y + 4); g.stroke();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const local = (e: React.PointerEvent | React.WheelEvent) => {
    const b = ref.current!.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  const hoverAt = (x: number, y: number) => {
    const w = mapRenderer()?.town, t = st.current.cam.tileAt(x, y);
    st.current.hover = t;
    const b = w?.buildingAt(t.x, t.y);
    setLabel(b ? b.name : w?.inBank(t.x, t.y) ? "The Bank" : null);
  };

  if (!ready) return null;
  return (
    <div className="minimap" style={{ width: W, height: H, display: hidden ? "none" : undefined }}>
      <canvas
        ref={ref}
        style={{ width: W, height: H }}
        title="Click to walk there · drag to look around · scroll to zoom"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const p = local(e), cam = st.current.cam;
          st.current.press = { x: p.x, y: p.y, cx: cam.cx, cy: cam.cy, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const p = local(e), s = st.current, pr = s.press;
          if (pr) {
            if (!pr.moved && Math.hypot(p.x - pr.x, p.y - pr.y) > DRAG_PX) { pr.moved = true; setFollow(false); s.follow = false; }
            if (pr.moved) { s.cam.cx = pr.cx - (p.x - pr.x) / s.cam.z; s.cam.cy = pr.cy - (p.y - pr.y) / s.cam.z; }
          }
          hoverAt(p.x, p.y);
          e.currentTarget.style.cursor = pr?.moved ? "grabbing" : "pointer";
        }}
        onPointerUp={(e) => {
          const pr = st.current.press; st.current.press = null;
          e.currentTarget.style.cursor = "pointer";
          if (!pr || pr.moved) return;
          (document.activeElement as HTMLElement | null)?.blur();
          const t = st.current.cam.tileAt(pr.x, pr.y);
          if (mapRenderer()?.walkToTile(t.x, t.y)) { setFollow(true); st.current.follow = true; }
        }}
        onPointerLeave={() => { if (!st.current.press) { st.current.hover = null; setLabel(null); } }}
        onWheel={(e) => {
          const s = st.current, p = local(e), before = s.cam.toWorld(p.x, p.y);
          s.mult = Math.max(MIN, Math.min(MAX, s.mult * (e.deltaY < 0 ? 1.25 : 0.8)));
          // following: zoom about me; looking around: about the pointer
          const w = mapRenderer()?.town; if (!w || s.follow) return;
          s.cam.z = s.cam.fit(w.w * T, w.h * T) * s.mult;
          const after = s.cam.toWorld(p.x, p.y);
          s.cam.cx += before.x - after.x; s.cam.cy += before.y - after.y;
        }}
      />
      {label ? <div className="minimap-label">{label}</div> : null}
      {!follow ? <button className="minimap-me" title="Back to me" onClick={() => setFollow(true)}>◎</button> : null}
    </div>
  );
}
