/**
 * The Balance tab's "Day by day" chart (Bank Transparency grant gr_epbcgb0hvs, kr_86jpcp8x0w): GET /api/finance `daily`,
 * the last 30 UTC days. Bars are the adj. tokens the Bank's debits drew each day, stacked by building (the 4 largest over
 * the window, the rest as "Other"); the line is what the Bank's inputs credited that day. One y-axis: both are adj.
 * tokens. Hovering (or focusing) a day shows its numbers; its four sum checks (dailyCheck, utilization, limits, split) fold into one "✓ 4 checks pass" line (gr_upr4fteq0t); a table view sits below.
 */
import { useState } from "react";
import { CheckFold } from "./ui";
import type { DayLimits, Finance, FinanceDaily, SplitWindow, UtilizationWindow, WindowLimits } from "../api";

/** Fixed categorical order (dark steps of the dataviz palette); "Other" is neutral gray. Colour follows the building's slot, not its day's rank. */
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500"];
const OTHER = "#7d8197";
const CREDIT = "#e8e9f0";
const DAILY_TOP = 4;
const n = (x: number) => x.toLocaleString("en-US");

interface DailyStack { key: string; name: string; color: string }

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

/** Work versus coordination (gr_3ougmyubdm): the bars' second view and its colours. Work is the accent blue, coordination orange. */
const SPLIT_STACKS: DailyStack[] = [
  { key: "work", name: "Work (grants, requests, exploration, retainers)", color: "#3987e5" },
  { key: "coordination", name: "Coordination (manager and Secretary wakes)", color: "#d95926" },
  { key: "other", name: "Other (reviews, meetings, summaries)", color: OTHER },
];

/**
 * One day's bar split into work, coordination and other. The bar is the day's Bank debits (`used`); the split is that
 * day's session spend by lane (`byLane`), so each part is `used` × its lane share. The parts sum to `used` exactly
 * (other takes the rounding). A day with no session spend is all other.
 */
export function splitSegments(row: FinanceDaily["rows"][number]): { key: string; tokens: number }[] {
  const l = row.byLane;
  const work = l ? l.grant + l.exploration + l.directed + l.retainer : 0, coord = l ? l.manager : 0;
  const total = l ? work + coord + l.other : 0;
  const w = total > 0 ? Math.round((row.used * work) / total) : 0, c = total > 0 ? Math.round((row.used * coord) / total) : 0;
  return [{ key: "work", tokens: w }, { key: "coordination", tokens: c }, { key: "other", tokens: row.used - w - c }];
}

const pct = (share: number) => `${Math.round(share * 100)}%`;

/** The sentence under the chart (kr_6fwxvjormh): "Last 7 days: X adj. tokens; A% bought work (…), B% went to managers and the Secretary coordinating". */
export function splitSentence(w: SplitWindow): string {
  const head = `Last ${w.days} days: ${n(Math.round(w.total.tokens))} adj. tokens; ${pct(w.work.share)} bought work (grants, requests, exploration, retainers), ${pct(w.coordination.share)} went to managers and the Secretary coordinating`;
  return w.other.tokens > 0 ? `${head}; ${pct(w.other.share)} other (reviews, meetings, summaries).` : `${head}.`;
}

/** The ✓ line under the sentences: `split.check`. */
export function splitCheckLine(f: Pick<Finance, "split">): { ok: boolean; text: string } | null {
  const s = f.split;
  if (!s) return null;
  const sum = (w: SplitWindow) => `${n(Math.round(w.work.tokens))} + ${n(Math.round(w.coordination.tokens))} + ${n(Math.round(w.other.tokens))} = ${n(Math.round(w.total.tokens))}`;
  const text = `7 days: ${sum(s.d7)}; 30 days: ${sum(s.d30)}. Work + coordination + other = the sessions' total, which equals the chart's daily session spend`;
  return s.check.ok ? { ok: true, text } : { ok: false, text: `${text}: off by ${n(s.check.diff)} (sessions), ${n(s.check.dailyDiff)} (daily rows)` };
}

/** The two sentences and their ✓ line, under the chart. */
function SplitSummary({ f }: { f: Finance }) {
  const s = f.split;
  if (!s) return null;
  return (
    <div className="split-summary" id="bank-glance-split" style={{ marginTop: 6 }}>
      <p style={{ margin: "2px 0" }}>{splitSentence(s.d7)}</p>
      <p style={{ margin: "2px 0" }}>{splitSentence(s.d30)}</p>
    </div>
  );
}

const pct1 = (share: number) => `${(Math.round(share * 1000) / 10).toFixed(1)}%`;

/**
 * How much of what came in was used (gr_z13gmx54su, kr_c0g8tvidke): "Last 7 days: X subscription tokens came in; Y were
 * used (p%), Z expired undrawn (q%) and W are still left until renewal." From `utilization`, per credit.
 */
export function utilizationSentence(w: UtilizationWindow): string {
  if (w.credited === 0 && w.durable === 0) return `Last ${w.days} days: no tokens came in.`;
  const parts = [`${n(w.used)} were used (${pct1(w.usedShare)})`, `${n(w.expired)} expired undrawn (${pct1(w.expiredShare)})`];
  const left = w.left > 0 ? ` and ${n(w.left)} are still left until renewal` : "";
  const head = `Last ${w.days} days: ${n(w.credited)} subscription tokens came in; ${parts.join(left ? ", " : " and ")}${left}`;
  return w.durable > 0 ? `${head}. Plus ${n(w.durable)} API-key tokens, which never expire.` : `${head}.`;
}

/** The ✓ line under the two sentences: `utilization.check`. */
export function utilizationCheckLine(f: Pick<Finance, "utilization">): { ok: boolean; text: string } | null {
  const u = f.utilization;
  if (!u) return null;
  const sum = (w: UtilizationWindow) => `${n(w.used)} + ${n(w.expired)} + ${n(w.left)} = ${n(w.credited)}`;
  const text = `7 days: ${sum(u.d7)}; 30 days: ${sum(u.d30)}. Used + expired + left = credited, credit by credit, and the credits match the chart's credited line`;
  return u.check.ok ? { ok: true, text } : { ok: false, text: `${text}: off by ${n(u.check.diff)} (credits), ${n(u.check.dailyDiff)} (daily rows)` };
}

/** The two used-share sentences and their ✓ line, under the chart. */
function UtilizationSummary({ f }: { f: Finance }) {
  const u = f.utilization;
  if (!u) return null;
  return (
    <div className="utilization-summary" id="bank-glance-used" style={{ marginTop: 6 }}>
      <p style={{ margin: "2px 0" }}>{utilizationSentence(u.d7)}</p>
      <p style={{ margin: "2px 0" }}>{utilizationSentence(u.d30)}</p>
      <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Subscription tokens do not roll over: what is not drawn before the next renewal expires. Used counts what was drawn from these credits, up to each credit&apos;s size.</div>
    </div>
  );
}

/** A desk share as a whole percent; a share above 0 but under half a percent reads "under 1%". */
export function deskPct(share: number): string {
  return share > 0 && share < 0.005 ? "under 1%" : `${Math.round(share * 100)}%`;
}
const plural = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;

/**
 * What held spending back over a window (gr_6c24p5uy01, kr_k9eiapj5ka): "Desks were busy 1% of the time. Exploration
 * reached its 500,000-a-day cap on 6 of 7 days. Grant work ran on 5 days." `cap` is today's town cap (null = uncapped).
 */
export function limitsSentence(w: WindowLimits, cap: number | null): string {
  const desk = w.deskHours > 0 ? `Desks were busy ${deskPct(w.deskShare)} of the time.` : "No desks were counted.";
  const explore = cap === null ? "Exploration had no daily cap." : `Exploration reached its ${n(cap)}-a-day cap on ${w.capDays} of ${w.days} days.`;
  const grant = w.grantDays === 0 ? "No grant work ran." : `Grant work ran on ${plural(w.grantDays, "day")}.`;
  return `${desk} ${explore} ${grant}`;
}

/** A UTC time "14:05" from an ISO stamp. */
const hhmm = (iso: string) => iso.slice(11, 16);

/**
 * One day's limit (kr_whv4vsbi6q), as short parts: desk use, the exploration cap (reached at what time, or how much of it
 * was spent), grant work, and (today only) the work held now.
 */
export function dayLimitParts(l: DayLimits): string[] {
  const share = l.deskHours > 0 ? l.deskHoursBusy / l.deskHours : 0;
  const parts = [`desks busy ${deskPct(share)} (${l.deskHoursBusy.toFixed(1)} of ${n(Math.round(l.deskHours))} desk-hours)`];
  const e = l.exploration;
  parts.push(e.cap === null ? `exploration ${n(e.tokens)}, no cap`
    : e.reachedAt ? `exploration cap reached at ${hhmm(e.reachedAt)} UTC`
    : `exploration ${n(e.tokens)} of its ${n(e.cap)} cap`);
  parts.push(l.grantTokens > 0 ? `grant work ${n(l.grantTokens)}` : "no grant work");
  if (l.held !== null && l.held > 0) parts.push(`${plural(l.held, "assignment")} held now`);
  return parts;
}

/** The ✓ line under the limits sentences: `limitsCheck`. */
export function limitsCheckLine(f: Pick<Finance, "limitsCheck">): { ok: boolean; text: string } | null {
  const c = f.limitsCheck;
  if (!c) return null;
  const text = "Each day's exploration and grant tokens equal its session spend in those lanes, and no day's busy desk-hours exceed the available ones";
  if (c.ok) return { ok: true, text };
  const off = [c.diff ? `tokens off by ${n(c.diff)}` : "", c.overDays ? `${plural(c.overDays, "day")} over the desk-hours` : ""].filter(Boolean).join(", ");
  return { ok: false, text: `${text}: ${off}` };
}

const LIMITS_NOTE_FALLBACK = "Past days use today's desks and today's exploration cap.";

/** "What held spending back": a line for 7 and 30 days under the used-share sentences, its ✓ line and a muted note. */
function LimitsSummary({ f }: { f: Finance }) {
  const u = f.utilization;
  if (!u?.d7.limits || !u.d30.limits) return null;
  const last = f.daily?.rows[f.daily.rows.length - 1]?.limits;
  const cap = last ? last.exploration.cap : null;
  return (
    <div className="limits-summary" style={{ marginTop: 6 }}>
      <p style={{ margin: "2px 0" }}>What held spending back, last 7 days: {limitsSentence(u.d7.limits, cap)}</p>
      <p style={{ margin: "2px 0" }}>Last 30 days: {limitsSentence(u.d30.limits, cap)}</p>
      <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>{f.limitsNote ?? LIMITS_NOTE_FALLBACK}</div>
    </div>
  );
}

/** The ✓ line under the chart (kr_l0zj80iz8z). */
export function dailyCheckLine(f: Pick<Finance, "daily" | "dailyCheck">): { ok: boolean; text: string } | null {
  const c = f.dailyCheck, d = f.daily;
  if (!c || !d) return null;
  const head = `Σ daily used ${n(c.rowsUsed)} = Bank used since ${d.from} ${n(c.usedSinceStart)}`;
  const exp = c.rowsExpired !== undefined ? `; Σ daily expired ${n(c.rowsExpired)} = Bank expired since ${d.from}` : "";
  return c.ok ? { ok: true, text: `${head}${exp}; each day's buildings add up to its used` }
    : { ok: false, text: `${head}: off by ${n(c.diff)}${c.buildingDiff ? `, buildings off by ${n(c.buildingDiff)}` : ""}${c.expiredDiff ? `, expired off by ${n(c.expiredDiff)}` : ""}` };
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
  const hasLanes = !!d?.rows.some((r) => r.byLane);
  const [mode, setMode] = useState<"lane" | "building">("lane");
  if (!d || d.rows.length === 0) return null;
  const byLane = hasLanes && mode === "lane";
  const stacks = byLane ? SPLIT_STACKS : dailyStacks(d);
  const segsOf = (r: FinanceDaily["rows"][number]) => (byLane ? splitSegments(r) : daySegments(r, stacks));
  const top = niceMax(Math.max(...d.rows.map((r) => Math.max(r.used, r.credited))));
  const pw = W - L - R, ph = H - T - B, slot = pw / d.rows.length, bw = Math.max(2, Math.min(18, slot - 3));
  const y = (v: number) => T + ph - (v / top) * ph;
  const x = (i: number) => L + i * slot + slot / 2;
  const ticks = [0, top / 2, top];
  const line = d.rows.map((r, i) => `${x(i).toFixed(1)},${y(r.credited).toFixed(1)}`).join(" ");
  const checks = [dailyCheckLine(f), utilizationCheckLine(f), limitsCheckLine(f), splitCheckLine(f)];
  const h = hover === null ? null : d.rows[hover]!;
  const hasExpired = d.rows.some((r) => r.expired !== undefined);
  const hasLimits = d.rows.some((r) => r.limits);
  const labelEvery = Math.ceil(d.rows.length / 6);
  return (
    <div className="daily-chart" aria-label="Day by day: tokens used and credited per UTC day">
      {hasLanes ? (
        <div className="daily-mode" role="group" aria-label="Split the bars by" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--fs-sm)", marginBottom: 4 }}>
          <span className="muted">Split by:</span>
          <button type="button" className="btn sm bank-toggle" aria-pressed={mode === "lane"} onClick={() => setMode("lane")}>Work vs coordination</button>
          <button type="button" className="btn sm bank-toggle" aria-pressed={mode === "building"} onClick={() => setMode("building")}>Building</button>
        </div>
      ) : null}
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
            const segs = segsOf(r).filter((s) => s.tokens > 0);
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
            aria-label={`${r.day}: used ${n(r.used)}, credited ${n(r.credited)}${r.expired !== undefined ? `, expired ${n(r.expired)}` : ""}${r.limits ? `; ${dayLimitParts(r.limits).join(", ")}` : ""}`}
            onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />)}
        </svg>
        {h ? (
          <div className="daily-tip" role="status" style={{ position: "absolute", top: 0, [hover! < d.rows.length / 2 ? "left" : "right"]: 8, background: "var(--panel-2)", border: "1px solid var(--line-2)", borderRadius: 6, padding: "6px 8px", fontSize: "var(--fs-sm)", pointerEvents: "none", minWidth: 180 }}>
            <b>{h.day}</b> (UTC)
            <div>Used: <b>{n(h.used)}</b></div>
            <div>Credited: <b>{n(h.credited)}</b></div>
            {hasExpired ? <div>Expired (undrawn): <b>{n(h.expired ?? 0)}</b></div> : null}
            {h.limits ? <div className="daily-tip-limit">Limit: {dayLimitParts(h.limits).join("; ")}</div> : null}
            {segsOf(h).filter((s) => s.tokens > 0).map((s) => {
              const st = stacks.find((x2) => x2.key === s.key)!;
              return <div key={s.key} className="muted"><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: st.color, marginRight: 4 }} />{st.name}: {n(s.tokens)}</div>;
            })}
          </div>
        ) : null}
      </div>
      <UtilizationSummary f={f} />
      <LimitsSummary f={f} />
      <SplitSummary f={f} />
      <CheckFold checks={checks} className="daily-checks">
        {checks.map((c, i) => c ? <div key={i} className={c.ok ? "muted" : "error-line"} style={{ fontSize: "var(--fs-sm)" }}>{c.ok ? "✓" : "✗"} {c.text}</div> : null)}
      </CheckFold>
      {d.undatedUsed > 0 ? <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Not in the bars: {n(d.undatedUsed)} spent from donations straight to buildings, which carry no date.</div> : null}
      <details>
        <summary className="muted" style={{ fontSize: "var(--fs-sm)" }}>The numbers as a table</summary>
        <table className="table">
          <thead><tr><th>Day (UTC)</th><th>Used</th><th>Credited</th>{hasExpired ? <th>Expired</th> : null}{hasLimits ? <th>Limit</th> : null}{stacks.map((s) => <th key={s.key}>{s.name}</th>)}</tr></thead>
          <tbody>{[...d.rows].reverse().map((r) => <tr key={r.day}><td>{r.day}</td><td>{n(r.used)}</td><td>{n(r.credited)}</td>{hasExpired ? <td>{n(r.expired ?? 0)}</td> : null}{hasLimits ? <td>{r.limits ? dayLimitParts(r.limits).join("; ") : ""}</td> : null}{segsOf(r).map((s) => <td key={s.key}>{n(s.tokens)}</td>)}</tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}

/** The sidebar's line on how to read the chart. */
export const DailyAbout = () => (
  <p className="muted">Day by day: each bar is what the Bank paid out that UTC day ({"adj. tokens"}). By default it is split into work (grant, request, exploration and retainer sessions), coordination (manager and Secretary wakes) and other, by that day&apos;s session spend in each lane; switch to Building to split it by the building whose sessions used it (the 4 largest over the window, the rest as Other). The line is what the Bank&apos;s inputs credited that day; subscription credit not drawn before renewal expires, and each day shows what expired on it. Each day also shows its limit: how busy the desks were, whether exploration reached its daily cap, and whether grant work ran. Hover or tab to a day for its numbers.</p>
);
