/**
 * User stats (the Town Hall's stats stand, 1:1 mt_ec2b7x80rg decision 2): how strangers become members, from GET /api/join-funnel.
 * Counts only, never who. The 30-day total on top, then by day, then per collective (the root server lists every hosted
 * collective; a hosted one gets only its own numbers). A new step is one entry in COLUMNS.
 */
import type { ReactNode } from "react";
import { api, API_BASE, type JoinFunnelCounts, type JoinFunnelView } from "../api";
import { Glyph, PanelShell } from "./PanelShell";
import { Empty, ErrorLine, Loading, Section, useLoad } from "./ui";

/** The steps in funnel order: short column label and what the number is. */
export const COLUMNS: { key: keyof JoinFunnelCounts; label: string; what: string }[] = [
  { key: "guestCardViews", label: "Saw card", what: "page loads that showed the signed-out guest card. Rough: the page pings it without signing in, so our own checks and reloads count too" },
  { key: "signIns", label: "Signed in", what: "first sign-ins with GitHub (a GitHub account seen for the first time)" },
  { key: "asked", label: "Asked", what: "requests to join (Ask to join on the guest card)" },
  { key: "letIn", label: "Let in", what: "requests an admin granted: the account became a member" },
  { key: "declined", label: "Declined", what: "requests an admin declined" },
];

/** A wait to decision, short: "40 s", "12 min", "3 h", "2 days". */
export function waitLabel(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 2 * 86_400_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.round(ms / 86_400_000)} days`;
}

/** The days with any count over every collective in the view, newest first (the top level carries no daily rows: they are summed here). */
export function byDay(f: JoinFunnelView): ({ day: string } & JoinFunnelCounts)[] {
  const m = new Map<string, { day: string } & JoinFunnelCounts>();
  for (const c of f.collectives) for (const d of c.daily) {
    const row = m.get(d.day) ?? { day: d.day, guestCardViews: 0, signIns: 0, asked: 0, letIn: 0, declined: 0 };
    for (const col of COLUMNS) row[col.key] += d[col.key];
    m.set(d.day, row);
  }
  return [...m.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/** A UTC day "2026-10-31" as "Oct 31" (the year is in the range line above). */
const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const median = (ms: number | null) => ms == null ? "none yet" : waitLabel(ms);
const n = (x: number) => x.toLocaleString("en-US");

function CountsTable({ first, rows }: { first: string; rows: { key: string; head: ReactNode; counts: JoinFunnelCounts; wait?: number | null }[] }) {
  const wait = rows.some((r) => r.wait !== undefined);
  return (
    <div className="stats-scroll"><table className="table stats-table">
      <thead><tr><th>{first}</th>{COLUMNS.map((c) => <th key={c.key} className="num" title={c.what}>{c.label}</th>)}{wait ? <th className="num" title="Median wait from asking to an admin's decision">Wait</th> : null}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.head}</td>
            {COLUMNS.map((c) => <td key={c.key} className="num">{r.counts[c.key] ? n(r.counts[c.key]) : <span className="faint">0</span>}</td>)}
            {wait ? <td className="num">{r.wait == null ? <span className="faint">–</span> : waitLabel(r.wait)}</td> : null}
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

export function StatsView({ f }: { f: JoinFunnelView }) {
  const days = byDay(f);
  const many = f.collectives.length > 1;
  return (
    <>
      <Section title={`Last ${f.days} days`} right={<a className="link" href={`${API_BASE}/api/join-funnel`} target="_blank" rel="noreferrer">JSON</a>}>
        <div className="stats-totals">
          {COLUMNS.map((c) => (
            <div key={c.key} className="stats-total" title={c.what}><b>{n(f.totals[c.key])}</b><span>{c.label}</span></div>
          ))}
          <div className="stats-total" title="Median wait from asking to an admin's decision, over the decided requests"><b>{median(f.medianDecisionMs)}</b><span>Typical wait</span></div>
        </div>
        <div className="muted">
          {f.from} to {f.to} (UTC days), {API_BASE ? "this collective" : many ? "every collective on this server" : "this collective"}. {f.decisions} {f.decisions === 1 ? "request" : "requests"} decided.
        </div>
      </Section>
      <Section title="By day">
        {days.length ? <CountsTable first="Day (UTC)" rows={days.map((d) => ({ key: d.day, head: <span title={d.day}>{dayLabel(d.day)}</span>, counts: d }))} /> : <Empty>Nothing counted in the last {f.days} days.</Empty>}
      </Section>
      {many ? (
        <Section title="Per collective">
          <CountsTable first="Collective" rows={f.collectives.map((c) => ({ key: c.slug, head: <a className="link" href={`/${c.slug}/`}>{c.slug}</a>, counts: c.totals, wait: c.medianDecisionMs }))} />
        </Section>
      ) : null}
      <Section title="What the numbers are">
        <dl className="kv">
          {COLUMNS.map((c) => <div key={c.key}><dt>{c.label}</dt><dd>{c.what}.</dd></div>)}
          <div><dt>Typical wait</dt><dd>the median time from asking to join to an admin letting the account in or declining it.</dd></div>
        </dl>
        <div className="muted">Counts only: no login or account id is kept for these numbers. Each day is a UTC day.</div>
      </Section>
    </>
  );
}

export function StatsPanel() {
  const f = useLoad(() => api().joinFunnel(), []);
  return (
    <PanelShell icon={<Glyph kind="stats" />} title="User stats" subtitle="How strangers become members: saw the guest card, signed in, asked to join, were let in">
      <ErrorLine error={f.error} />
      {f.loading && !f.data ? <Loading /> : f.data ? <StatsView f={f.data} /> : null}
    </PanelShell>
  );
}
