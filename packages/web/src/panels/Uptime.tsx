/**
 * The public Uptime block (grant gr_rcj8nkbkbt, kr_ay5wb5wfhd): the 30-day % measured from outside by the pinger, a
 * 30-cell day strip and the outage list, from the public `GET /api/uptime` (server/src/uptime.ts `UptimeSummary`). Shown at
 * the Bank server rack (BankPanel.tsx, the Hosting tab) and on the signed-out landing (home/main.tsx mounts it into
 * home.ts's `#uptime`). Always the root server's `/api/uptime`: a hosted collective runs on the same Machine.
 * A day with no probe is grey ("not measured"), never green.
 */
import { useEffect, useState, type ReactNode } from "react";

export interface UptimeDay { date: string; up: number; down: number; unknown: number; pct: number | null }
export interface UptimeData {
  at: string; days: number; pct: number | null; coverage: number;
  up: number; down: number; unknown: number; lastProbeAt: string | null;
  byDay: UptimeDay[];
  outages: { from: string; to: string; minutes: number }[];
  restarts: { from: string; to: string; seconds: number; kind: "redeploy" | "unclean" }[];
}

/** GET /api/uptime once; null while loading or when it fails (the block then stays hidden). */
function useUptime(): UptimeData | null {
  const [u, setU] = useState<UptimeData | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/uptime").then((r) => (r.ok ? r.json() : null)).then((d) => { if (live && d?.byDay) setU(d as UptimeData); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return u;
}

/** A day cell's colour: green at ≥ 99.9 %, amber at ≥ 99 %, red below; grey when no probe saw the day. */
export function dayColor(pct: number | null): string {
  if (pct === null) return "var(--faint)";
  return pct >= 99.9 ? "var(--ok)" : pct >= 99 ? "var(--amber)" : "var(--bad)";
}

const when = (iso: string) => iso.slice(0, 16).replace("T", " ");
const dur = (min: number) => (min >= 120 ? `${Math.round(min / 6) / 10} h` : `${min} min`);

/** The block given the data: headline, day strip, outages (newest first, 8 at most), restart count. */
export function UptimeView({ u }: { u: UptimeData }) {
  const outages = [...u.outages].reverse().slice(0, 8);
  const unclean = u.restarts.filter((r) => r.kind === "unclean").length;
  return (
    <div className="uptime" aria-label="Uptime">
      <p style={{ margin: "0 0 6px" }}>
        {u.pct === null
          ? <b>Not measured yet.</b>
          : <><b style={{ fontSize: "var(--fs-xl)" }}>{u.pct}%</b> up over the last {u.days} days</>}
        <span className="muted"> · measured by UptimeRobot; {u.coverage}% of minutes measured</span>
      </p>
      <div role="img" aria-label={`Day strip, oldest to today: ${u.byDay.map((d) => `${d.date} ${d.pct === null ? "not measured" : `${d.pct}%`}`).join(", ")}`}
        style={{ display: "flex", gap: 2, margin: "0 0 6px" }}>
        {u.byDay.map((d) => (
          <span key={d.date} className="uptime-day" data-pct={d.pct ?? ""}
            title={`${d.date}: ${d.pct === null ? "not measured" : `${d.pct}% up`} (${d.up} up, ${d.down} down, ${d.unknown} not measured, minutes)`}
            style={{ flex: "1 1 0", minWidth: 4, height: 22, borderRadius: 2, background: dayColor(d.pct) }} />
        ))}
      </div>
      {outages.length ? (
        <ul className="uptime-outages" style={{ margin: "0 0 4px", paddingLeft: 18 }}>
          {outages.map((o) => <li key={o.from}>Down {when(o.from)} → {when(o.to)} UTC ({dur(o.minutes)})</li>)}
        </ul>
      ) : <p className="muted" style={{ margin: "0 0 4px" }}>{u.pct === null ? "" : "No outages in this window."}</p>}
      <p className="muted" style={{ margin: 0 }}>
        {u.restarts.length} restart{u.restarts.length === 1 ? "" : "s"} in the window{unclean ? `, ${unclean} unclean` : ""}. Raw figures: <a href="/api/uptime">/api/uptime</a>.
      </p>
    </div>
  );
}

/** Fetches and shows the block; `fallback` (default nothing) until the figures load or when they can't. */
export function UptimeBlock({ fallback = null }: { fallback?: ReactNode }) {
  const u = useUptime();
  return u ? <UptimeView u={u} /> : <>{fallback}</>;
}
