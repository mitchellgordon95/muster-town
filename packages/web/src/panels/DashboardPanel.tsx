/**
 * The town dashboard (docs/goal-directed-budgets.md "Objectives and KPIs"): the framing, the three town KPIs (Fund,
 * Join, Trust: this week, last week, an 8-week sparkline, the measure), then each goal-directed building's objectives
 * with the KPI each moves and its key results' statuses. KPIs are standing indicators, never met or missed.
 */
import type { KpiView } from "@muster-town/schema";
import { api } from "../api";
import { store } from "../state";
import { Glyph, PanelShell } from "./PanelShell";
import { krStatusLabel, krTone, objectiveLine } from "./keyResults";
import { Empty, ErrorLine, Loading, Pill, Section, useLoad } from "./ui";

export function DashboardPanel() {
  const d = useLoad(() => api().kpis(), []);
  return (
    <PanelShell icon={<Glyph kind="bank" />} title="Dashboard" subtitle="The town goal as three KPIs: Fund, Join, Trust">
      {d.loading && !d.data ? <Loading /> : null}
      <ErrorLine error={d.error} />
      {d.data ? <>
        <Section title="Town goal">
          <p className="direction">{d.data.framing}</p>
          <div className="kpi-tiles">{d.data.kpis.map((k) => <KpiTile key={k.id} k={k} />)}</div>
        </Section>
        <Section title="Building objectives">
          {!d.data.buildings.length ? <Empty>No goal-directed buildings yet.</Empty> : null}
          {d.data.buildings.map((b) => (
            <div key={b.buildingId} className="kpi-building">
              <div className="kr-objective-head"><button className="link" onClick={() => store.open({ kind: "board", id: b.buildingId })}><b>{b.name}</b></button> <span className="muted">{b.goal}</span></div>
              {!b.objectives.length ? <div className="muted">No objectives yet{b.unsorted.length ? ` (${b.unsorted.length} key result${b.unsorted.length === 1 ? "" : "s"} under none)` : ""}.</div> : null}
              <ul className="kpi-objectives">
                {b.objectives.map((o) => (
                  <li key={o.id}>
                    <div>{o.text} <span className="muted">{objectiveLine(o)}</span></div>
                    <div className="kpi-krs">
                      {o.keyResults.length ? o.keyResults.map((k) => <Pill key={k.id} tone={krTone(k.status)} title={k.text}>{krStatusLabel(k.status)}</Pill>) : <span className="muted">no key results yet</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Section>
      </> : null}
    </PanelShell>
  );
}

/** One KPI: the name and measure, this week's value (big) against last week's, and the 8-week sparkline. */
function KpiTile({ k }: { k: KpiView }) {
  const delta = k.thisWeek - k.lastWeek;
  return (
    <div className="kpi-tile" title={k.measure}>
      <div className="kpi-name">{k.name}</div>
      <div className="kpi-value">{k.thisWeek.toLocaleString("en-US")}</div>
      <div className="muted kpi-delta">last week {k.lastWeek.toLocaleString("en-US")}{delta ? ` (${delta > 0 ? "+" : ""}${delta})` : ""}</div>
      <Sparkline weeks={k.weeks} label={`${k.name}, last ${k.weeks.length} weeks`} />
      <div className="muted kpi-measure">{k.measure}</div>
      <div className="muted kpi-detail">{k.detail}</div>
    </div>
  );
}

/** A single-series 8-week line (oldest left), 2px stroke on a baseline; each week has a hover title; the values are in aria-label. */
function Sparkline({ weeks, label }: { weeks: number[]; label: string }) {
  const W = 120, H = 28, pad = 4;
  const max = Math.max(1, ...weeks);
  const x = (i: number) => pad + (i * (W - 2 * pad)) / Math.max(1, weeks.length - 1);
  const y = (v: number) => H - pad - (v / max) * (H - 2 * pad);
  const pts = weeks.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  return (
    <svg className="kpi-spark" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`${label}: ${weeks.join(", ")}`}>
      <line x1={pad} x2={W - pad} y1={H - pad} y2={H - pad} className="kpi-spark-base" />
      <polyline points={pts} fill="none" className="kpi-spark-line" />
      {weeks.map((v, i) => (
        <g key={i}>
          <rect x={x(i) - 7} y={0} width={14} height={H} fill="transparent"><title>{`${weeks.length - 1 - i ? `${weeks.length - 1 - i} week${weeks.length - 1 - i === 1 ? "" : "s"} ago` : "this week"}: ${v}`}</title></rect>
          {i === weeks.length - 1 ? <circle cx={x(i)} cy={y(v)} r={3} className="kpi-spark-dot" /> : null}
        </g>
      ))}
    </svg>
  );
}
