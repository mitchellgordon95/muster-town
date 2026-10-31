/**
 * Spend by goal (docs/goals.md "Spend by goal", build step 4; a section of the Bank's Spending tab since 1:1
 * mt_n25udpflus decision 5 took it off the goal tree): a goal's subtree spend over a window, from session rows
 * (GET /api/goals/:id/spend), by lane, by day or week, by building and by key result, next to the key results met or
 * missed in the same window. Read-only: nothing here touches the Bank's books.
 */
import { useState } from "react";
import { ROOT_GOAL_ID, type GoalSpend, type SpendByLane } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { GoalPicker } from "./GoalPicker";
import { ADJ, ADJ_HINT, Empty, ErrorLine, Loading, Pill, Section, fmtTokens, useLoad } from "./ui";

export const SPEND_WINDOWS = [7, 30, 90] as const;
const LANES: { id: keyof SpendByLane; label: string }[] = [
  { id: "grant", label: "grant" }, { id: "exploration", label: "exploration" }, { id: "directed", label: "directed" }, { id: "none", label: "no lane" },
];

/** "grant 1.2M · directed 300k": the non-zero lanes, biggest first. */
export function laneLine(l: SpendByLane): string {
  return LANES.filter((x) => l[x.id] > 0).sort((a, b) => l[b.id] - l[a.id]).map((x) => `${x.label} ${fmtTokens(l[x.id])}`).join(" · ") || "nothing";
}

/** Bar widths (percent of the biggest bucket) for the series. */
export function seriesBars(s: GoalSpend["series"]): { start: string; tokens: number; pct: number }[] {
  const max = Math.max(1, ...s.map((b) => b.tokens));
  return s.map((b) => ({ start: b.start, tokens: b.tokens, pct: Math.round((b.tokens / max) * 100) }));
}

/** The Bank's "Spend by goal" section: pick a goal (the root by default), then its subtree's spend. */
export function SpendByGoal() {
  const [goalId, setGoalId] = useState<string>(ROOT_GOAL_ID);
  return (
    <Section title="Spend by goal" right={<GoalPicker value={goalId} onChange={setGoalId} />}>
      <GoalSpendView goalId={goalId} />
    </Section>
  );
}

function GoalSpendView({ goalId }: { goalId: string }) {
  const [days, setDays] = useState<number>(7);
  // the funder filter (goal tree step 8): a signed-in human narrows the tab to what their own Bank inputs paid for
  const signedIn = useTown((s) => !!s.me);
  const [mine, setMine] = useState(false);
  const r = useLoad(() => api().goalSpend(goalId, days, signedIn && mine ? "me" : undefined), [goalId, days, signedIn && mine]);
  const d = r.data;
  return (
    <div className="goal-spend">
      <div className="goal-spend-head">
        <span className="muted">Last</span>
        {SPEND_WINDOWS.map((w) => <button key={w} className={`btn sm ${w === days ? "primary" : ""}`} onClick={() => setDays(w)}>{w} days</button>)}
        {signedIn ? <label className="check" title="Only the sessions your Bank inputs paid for: whole on your key, your pro rata share of the subscription week"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Funded by me</label> : null}
        <span className="muted" title={ADJ_HINT}>this goal and everything under it, from session rows, in {ADJ}; read-only</span>
      </div>
      <ErrorLine error={r.error} />
      {!d ? (r.loading ? <Loading /> : null) : !d.sessions ? <Empty>{mine ? `None of your money paid for work on this goal or anything under it in the last ${d.days} days.` : `No sessions worked on this goal or anything under it in the last ${d.days} days.`}</Empty> : <>
        <div className="goal-spend-total"><b>{fmtTokens(d.total)}</b> {ADJ} over {d.sessions} session{d.sessions === 1 ? "" : "s"} <span className="muted">· {laneLine(d.byLane)}</span></div>
        <div className="goal-spend-bars" aria-label={`Spend by ${d.seriesUnit}`}>
          {seriesBars(d.series).map((b) => (
            <div key={b.start} className="goal-spend-bar" title={`${d.seriesUnit === "day" ? "Day" : "Week"} from ${b.start.slice(0, 10)}: ${fmtTokens(b.tokens)}`}>
              <span style={{ height: `${b.pct}%` }} /><small>{b.start.slice(5, 10)}</small>
            </div>
          ))}
        </div>
        <table className="goal-spend-table">
          <thead><tr><th>Building</th><th>Spent</th><th>Sessions</th><th>By lane</th></tr></thead>
          <tbody>{d.byBuilding.map((b) => (
            <tr key={b.id}><td><button className="link" onClick={() => store.open({ kind: "building", id: b.id })}>{b.name}</button></td><td>{fmtTokens(b.tokens)}</td><td>{b.sessions}</td><td className="muted">{laneLine(b.byLane)}</td></tr>
          ))}</tbody>
        </table>
        {d.byKeyResult.length ? (
          <table className="goal-spend-table">
            <thead><tr><th>Key result</th><th>Spent</th><th>Sessions</th></tr></thead>
            <tbody>{d.byKeyResult.map((k) => <tr key={k.id}><td>{k.text} <span className="muted">· {k.status.replace(/-/g, " ")}</span></td><td>{fmtTokens(k.tokens)}</td><td>{k.sessions}</td></tr>)}</tbody>
          </table>
        ) : <div className="muted">No session in this window named a key result (grant or exploration).</div>}
      </>}
      {d?.results.length ? (
        <div className="goal-spend-results">
          <b>Results in the same window:</b> {d.results.map((k) => <span key={k.id}><Pill tone={k.status === "met" ? "ok" : "bad"}>{k.status}</Pill> {k.text} <span className="muted">{k.at.slice(0, 10)}</span> </span>)}
        </div>
      ) : d ? <div className="muted">No key result under this goal was marked met or missed in the last {d.days} days.</div> : null}
    </div>
  );
}
