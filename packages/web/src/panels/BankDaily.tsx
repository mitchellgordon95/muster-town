/**
 * The Balance tab's "Day by day" chart (Bank Transparency grant gr_epbcgb0hvs, kr_86jpcp8x0w): GET /api/finance `daily`,
 * the last 30 UTC days. Bars are the adj. tokens the Bank's debits drew each day, stacked by building (the 4 largest over
 * the window, the rest as "Other"); the line is what the Bank's inputs credited that day. One y-axis: both are adj.
 * tokens. Hovering (or focusing) a day shows its numbers; the ✓ line under it is `dailyCheck`; a table view sits below.
 */
import { useState } from "react";
import type { Finance, FinanceDaily } from "../api";

/** Fixed categorical order (dark steps of the dataviz palette); "Other" is neutral gray. Colour follows the building's slot, not its day's rank. */
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500"];
const OTHER = "#7d8197";
const CREDIT = "#e8e9f0";
export const DAILY_TOP = 4;
const n = (x: number) => x.toLocaleString("en-US");

export interface DailyStack { key: string; name: string; color: string }

/** The stack's series: the top `DAILY_TOP` buildings by window total, then "Other" when more buildings used tokens. */
export function dailyStacks(d: FinanceDaily): DailyStack[] {
  const top = d.buildings.slice(0, DAILY_TOP).map((b, i) => ({ key: b.id, name: b.name, color: SERIES[i]! }));
  return d.buildings.length > DAILY_TOP ? [...top, { key: "other", name: `Other (${d.buildings.length - DAILY_TOP} buildings)`, color: OTHER }] : top;
}

/** One day's segments in stack order: each top building's tokens, then the rest summed as "other". */
export function daySegments(row: FinanceDaily["rows"][number], stacks: DailyStack[]): { key: string; tokens: number }[] {
  const named = new Set(stacks.map((s) => s.key));
  const other = Object.entries(row.byBuilding).filter(([id]) => !named.has(id)).reduce((s, [, t]) => s + t, 0);
  return stacks.map((s) => ({ key: s.key, tokens: s.key === "other" ? other : row.byBuilding[s.key] ?? 0 }));
}

/** The ✓ line under the chart (kr_l0zj80iz8z). */
export function dailyCheckLine(f: Pick<Finance, "daily" | "dailyCheck">): { ok: boolean; text: string } | null {
  const c = f.dailyCheck, d = f.daily;
  if (!c || !d) return null;
  const head = `Σ daily used ${n(c.rowsUsed)} = Bank used since ${d.from} ${n(c.usedSinceStart)}`;
  return c.ok ? { ok: true, text: `${head}; each day's buildings add up to its used` }
    : { ok: false, text: `${head}: off by ${n(c.diff)}${c.buildingDiff ? `, buildings off by ${n(c.buildingDiff)}` : ""}` };
}

/** A round axis top ≥ max: 1, 2, 2.5 or 5 × 10^k. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= max) ?? 10) * p;
}

/** An axis tick: "12.5M", "500k", "0" (fmtTokens would round 12.5M to "13M"). */
export function axisLabel(t: number): string {
  const [div, unit] = t >= 1e6 ? [1e6, "M"] : t >= 1e3 ? [1e3, "k"] : [1, ""];
  return `${Number((t / div).toFixed(2))}${unit}`;
}

const W = 640, H = 200, L = 44, R = 8, T = 10, B = 22;

export function DailyChart({ f }: { f: Finance }) {
  const d = f.daily;
  const [hover, setHover] = useState<number | null>(null);
  if (!d || d.rows.length === 0) return null;
  const stacks = dailyStacks(d);
  const top = niceMax(Math.max(...d.rows.map((r) => Math.max(r.used, r.credited))));
  const pw = W - L - R, ph = H - T - B, slot = pw / d.rows.length, bw = Math.max(2, Math.min(18, slot - 3));
  const y = (v: number) => T + ph - (v / top) * ph;
  const x = (i: number) => L + i * slot + slot / 2;
  const ticks = [0, top / 2, top];
  const line = d.rows.map((r, i) => `${x(i).toFixed(1)},${y(r.credited).toFixed(1)}`).join(" ");
  const check = dailyCheckLine(f);
  const h = hover === null ? null : d.rows[hover]!;
  const labelEvery = Math.ceil(d.rows.length / 6);
  return (
    <div className="daily-chart" aria-label="Day by day: tokens used and credited per UTC day">
      <div className="daily-legend" style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", fontSize: "var(--fs-sm)", marginBottom: 4 }}>
        {stacks.map((s) => <span key={s.key}><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: s.color, marginRight: 4 }} />{s.name}</span>)}
        <span><i style={{ display: "inline-block", width: 14, height: 0, borderTop: `2px solid ${CREDIT}`, verticalAlign: "middle", marginRight: 4 }} />Credited</span>
      </div>
      <div style={{ position: "relative" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Used and credited per day, ${d.from} to ${d.to}`} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">{axisLabel(t)}</text>
          </g>)}
          {d.rows.map((r, i) => {
            let acc = 0;
            const segs = daySegments(r, stacks).filter((s) => s.tokens > 0);
            return <g key={r.day}>
              {segs.map((s, j) => {
                const y0 = y(acc), y1 = y(acc + s.tokens);
                acc += s.tokens;
                const gap = j < segs.length - 1 ? 1 : 0; // a 2px surface gap between segments (1px off each side)
                return <rect key={s.key} x={x(i) - bw / 2} y={y1 + gap} width={bw} height={Math.max(0.5, y0 - y1 - gap)} rx={j === segs.length - 1 ? 2 : 0}
                  fill={stacks.find((st) => st.key === s.key)!.color} opacity={hover === null || hover === i ? 1 : 0.55} />;
              })}
              {i % labelEvery === 0 || i === d.rows.length - 1 ? <text x={x(i)} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--muted)">{r.day.slice(5)}</text> : null}
            </g>;
          })}
          <polyline points={line} fill="none" stroke={CREDIT} strokeWidth={2} strokeLinejoin="round" />
          {d.rows.map((r, i) => r.credited > 0 && hover === i ? <circle key={r.day} cx={x(i)} cy={y(r.credited)} r={4} fill={CREDIT} stroke="var(--panel)" strokeWidth={2} /> : null)}
          {d.rows.map((r, i) => <rect key={r.day} x={L + i * slot} y={T} width={slot} height={ph} fill="transparent" tabIndex={0}
            aria-label={`${r.day}: used ${n(r.used)}, credited ${n(r.credited)}`}
            onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />)}
        </svg>
        {h ? (
          <div className="daily-tip" role="status" style={{ position: "absolute", top: 0, [hover! < d.rows.length / 2 ? "left" : "right"]: 8, background: "var(--panel-2)", border: "1px solid var(--line-2)", borderRadius: 6, padding: "6px 8px", fontSize: "var(--fs-sm)", pointerEvents: "none", minWidth: 180 }}>
            <b>{h.day}</b> (UTC)
            <div>Used: <b>{n(h.used)}</b></div>
            <div>Credited: <b>{n(h.credited)}</b></div>
            {daySegments(h, stacks).filter((s) => s.tokens > 0).map((s) => {
              const st = stacks.find((x2) => x2.key === s.key)!;
              return <div key={s.key} className="muted"><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: st.color, marginRight: 4 }} />{st.name}: {n(s.tokens)}</div>;
            })}
          </div>
        ) : null}
      </div>
      {check ? <div className={check.ok ? "muted" : "error-line"} style={{ fontSize: "var(--fs-sm)" }}>{check.ok ? "✓" : "✗"} {check.text}</div> : null}
      {d.undatedUsed > 0 ? <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Not in the bars: {n(d.undatedUsed)} spent from donations straight to buildings, which carry no date.</div> : null}
      <details>
        <summary className="muted" style={{ fontSize: "var(--fs-sm)" }}>The numbers as a table</summary>
        <table className="table">
          <thead><tr><th>Day (UTC)</th><th>Used</th><th>Credited</th>{stacks.map((s) => <th key={s.key}>{s.name}</th>)}</tr></thead>
          <tbody>{[...d.rows].reverse().map((r) => <tr key={r.day}><td>{r.day}</td><td>{n(r.used)}</td><td>{n(r.credited)}</td>{daySegments(r, stacks).map((s) => <td key={s.key}>{n(s.tokens)}</td>)}</tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}

/** The sidebar's line on how to read the chart. */
export const DailyAbout = () => (
  <p className="muted">Day by day: each bar is what the Bank paid out that UTC day ({"adj. tokens"}), split by the building whose sessions used it (the 4 largest over the window, the rest as Other). The line is what the Bank&apos;s inputs credited that day. Hover or tab to a day for its numbers.</p>
);
