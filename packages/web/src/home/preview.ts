/**
 * Live town previews for the homepage tiles: the town zoomed out with the minimap's renderer (`drawOverview`), framed
 * on the building lots, people as status-coloured dots. One `/api/town` fetch per source every REFRESH_MS, shared by
 * every canvas that shows it; a canvas that leaves the page stops being drawn.
 */
import type { Snapshot } from "../api";
import { World } from "../map/world";
import { drawOverview, OverviewCam } from "../map/overview";
import { STATUS_COLOR } from "../map/overlay";
import { T } from "../map/sprites";

const REFRESH_MS = 20_000;

interface Feed { world: World | null; snap: Snapshot | null; canvases: Set<HTMLCanvasElement>; timer: number }
const feeds = new Map<string, Feed>();

/** Who is working right now (agents only; people and idle bodies aren't counted). */
export const workingCount = (snap: Snapshot) => snap.agents.filter((a) => a.kind !== "human" && a.status === "working").length;

function draw(c: HTMLCanvasElement, f: Feed) {
  const { world, snap } = f;
  if (!world || !snap) return;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  // the pill first: the framing below leaves room for it
  const live = c.parentElement?.querySelector(".tile-live");
  if (live) { const n = workingCount(snap); live.textContent = n ? `${n} working now` : "Resting now"; live.classList.toggle("on", n > 0); }
  // frame every lot (where the people are) between the "working now" pill and the name label
  const el = (sel: string) => c.parentElement?.querySelector<HTMLElement>(sel);
  const pill = el(".tile-live"), top = pill?.offsetHeight ? pill.offsetTop + pill.offsetHeight : 0;
  const bottom = el(".tile-name")?.offsetHeight ?? 0, vh = Math.max(h / 2, h - top - bottom);
  const lots = world.buildings.flatMap((b) => (b.lot ? [b.lot] : []));
  const x0 = Math.min(...lots.map((l) => l.x), world.w), x1 = Math.max(...lots.map((l) => l.x + l.w), 0);
  const y0 = Math.min(...lots.map((l) => l.y), world.h), y1 = Math.max(...lots.map((l) => l.y + l.h), 0);
  const bw = (lots.length ? x1 - x0 : world.w) * T, bh = (lots.length ? y1 - y0 : world.h) * T;
  const cam = new OverviewCam(w, h);
  cam.z = Math.min(w / bw, vh / bh) * 0.96;
  cam.cx = lots.length ? ((x0 + x1) / 2) * T : (world.w * T) / 2;
  cam.cy = (lots.length ? ((y0 + y1) / 2) * T : (world.h * T) / 2) + (bottom - top) / 2 / cam.z;
  const dots = snap.agents
    .filter((a) => a.status !== "retired" && a.status !== "banned")
    .map((a) => ({ x: a.pos.x * T + T / 2, y: a.pos.y * T + T, color: STATUS_COLOR[a.status] ?? "#9a9db3" }));
  drawOverview(g, world, cam, { dots, labelMinPx: Infinity });
}

async function refresh(src: string, f: Feed) {
  try {
    const res = await fetch(src);
    if (!res.ok) return;
    const snap = { type: "snapshot", ...(await res.json()) } as Snapshot;
    // the map rarely changes: rebake only when the grid or the lots do
    const key = (s: Snapshot) => JSON.stringify([s.grid.w, s.grid.h, s.buildings.map((b) => b.lot)]);
    if (!f.world || !f.snap || key(f.snap) !== key(snap)) f.world = new World(snap.grid, snap.buildings, snap.places);
    f.snap = snap;
  } catch { return; /* offline: keep the last picture */ }
  for (const c of [...f.canvases]) {
    if (!c.isConnected) f.canvases.delete(c);
    else draw(c, f);
  }
  if (!f.canvases.size) { clearInterval(f.timer); feeds.delete(src); }
}

/** Draw `src`'s town into `canvas` now (if loaded) and on every refresh. */
export function mountPreview(canvas: HTMLCanvasElement, src: string) {
  let f = feeds.get(src);
  if (!f) {
    const feed: Feed = { world: null, snap: null, canvases: new Set(), timer: 0 };
    feed.timer = window.setInterval(() => void refresh(src, feed), REFRESH_MS);
    feeds.set(src, f = feed);
    void refresh(src, feed);
  }
  f.canvases.add(canvas);
  draw(canvas, f);
}
