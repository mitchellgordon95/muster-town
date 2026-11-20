/**
 * The homepage's join-funnel pings (gr_zoo2cf2zpp, gr_ptle4vvujl): with no step, the page was opened (`homeViews`); with a
 * step, what this browser did next on the pitch card or the tiles. The server counts each once per browser per UTC day and
 * drops headless checks and crawlers. `keepalive`, so a ping sent as Open or a tile leaves the page still arrives.
 */
import { arrivalSource, visitorId } from "../visitor";

type HomeStep = "page2" | "page3" | "skip" | "open" | "tile";

export function countHome(step?: HomeStep): void {
  const visitor = visitorId();
  if (!visitor) return;
  fetch("/api/join-funnel/home", { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify(step ? { visitor, step } : { visitor, ...arrivalSource() }) }).catch(() => {});
}
