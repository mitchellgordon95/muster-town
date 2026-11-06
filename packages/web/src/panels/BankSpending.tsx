/**
 * The Bank's Spending tab as a drill-down (gr_567tikzitl step 4, kr_trhi5frg4k): one table at a time over GET
 * /api/finance/spend's tree. The top level lists the buildings (and the synthetic rows that make it sum to `used`);
 * clicking a building shows its grants, clicking a grant its assignments; a breadcrumb above the table goes back up.
 * The clicked row is the Bank sheet's picked row: `spend:` + its path (`spend:workshop/gr_a/as_a`), so BankView keeps
 * one `picked` for every tab. The sidebar's "Selected row" (`SpendSelected`) shows that row's detail: a building's figures,
 * its lanes over the last 24 h and its own funding; a grant's spent vs funded and key results; an assignment's sessions.
 * Drift and out-of-tokens deaths (`SpendingHealth`) sit in the sidebar too; Spend by goal sits behind the "By goal" toggle,
 * never below the drill-down. Prose goes in SpendingAbout (BankFinance), never here.
 */
import { useState, type ReactNode } from "react";
import { ROOT_GOAL_ID } from "@muster-town/schema";
import { api, type Bank, type FinanceSpend, type LaneKindRow, type LaneKindTable, type ManagerWakeLine, type ManagerWakes, type SpendByLaneKind, type SpendNode, type TokenKind } from "../api";
import { useTown } from "../state";
import { BuildingFunding, pickRow } from "./BankFunding";
import { GrantLine, NOTE_TITLE, dollars, grantLine, grantsCheckLine, pct, spendCheckLine, spendNotes, spendUsdCheckLine } from "./BankFinance";
import { SpendByGoal, laneLine } from "./GoalSpend";
import { ADJ, Loading, Section, fmtTokens, useLoad } from "./ui";

const n = (x: number) => Math.round(x).toLocaleString("en-US");

/** The prefix of a Spending row's picked id. */
export const SPEND_PICK = "spend:";
/** A row's key among its siblings: its id, or its kind for a synthetic row (each kind appears once per parent). */
const keyOf = (node: SpendNode) => node.id ?? node.kind;
/** The picked id of the row at this path. */
export const spendPick = (path: string[]) => SPEND_PICK + path.join("/");

/** The rows along a picked path, from the top; it stops at the first key the tree no longer has. */
export function spendTrail(rows: SpendNode[], picked: string | null | undefined): SpendNode[] {
  if (!picked?.startsWith(SPEND_PICK)) return [];
  const trail: SpendNode[] = [];
  let level = rows;
  for (const key of picked.slice(SPEND_PICK.length).split("/")) {
    const node = level.find((r) => keyOf(r) === key);
    if (!node) break;
    trail.push(node);
    level = node.children ?? [];
  }
  return trail;
}

/**
 * What the centre shows for a trail: the rows of the deepest picked row that has children (a leaf stays in its parent's
 * table, picked), and the rows above them (the breadcrumb).
 */
export function spendLevel(rows: SpendNode[], trail: SpendNode[]): { crumbs: SpendNode[]; rows: SpendNode[] } {
  const last = trail[trail.length - 1];
  const crumbs = last && !last.children?.length ? trail.slice(0, -1) : trail;
  return { crumbs, rows: crumbs.length ? crumbs[crumbs.length - 1].children ?? [] : rows };
}

const LEVEL_NAME = ["Building", "Grant", "Assignment"];

/** The Spending tab's centre: the drill-down, or Spend by goal behind its toggle. */
export function BankSpendingTab({ sp, picked, onPick }: { sp: FinanceSpend | null; picked: string | null; onPick: (id: string | null) => void }) {
  const [byGoal, setByGoal] = useState(false);
  const toggle = <button type="button" className="btn sm bank-toggle" aria-pressed={byGoal} onClick={() => setByGoal((x) => !x)}>{byGoal ? "By building" : "By goal"}</button>;
  if (byGoal) return <><SpendByGoal /><div className="bank-section-right">{toggle}</div></>;
  if (!sp) return null;
  return <SpendingDrill sp={sp} picked={picked} onPick={onPick} toggle={toggle} />;
}

/** One level of the drill-down: breadcrumb, one table (name · sessions · today on top · adj. tokens · $ · share), the checks. */
function SpendingDrill({ sp, picked, onPick, toggle }: { sp: FinanceSpend; picked: string | null; onPick: (id: string | null) => void; toggle?: ReactNode }) {
  const buildings = useTown((s) => s.buildings);
  const trail = spendTrail(sp.rows, picked);
  const { crumbs, rows } = spendLevel(sp.rows, trail);
  const top = !crumbs.length;
  const path = crumbs.map(keyOf);
  const today = (node: SpendNode) => (node.kind === "building" && node.id ? buildings.find((b) => b.id === node.id)?.budget?.tokensToday : undefined);
  const usd = sp.rows.some((r) => r.usd !== undefined);
  const check = spendCheckLine(sp), usdCheck = spendUsdCheckLine(sp), grantsCheck = grantsCheckLine(sp);
  const sum = rows.reduce((t, r) => t + r.tokens, 0);
  return (
    <Section title="Spending" right={toggle}>
      <nav className="bank-crumbs" aria-label="Where you are in Spending">
        {top ? <b>All buildings</b> : <button type="button" className="link" onClick={() => onPick(null)}>All buildings</button>}
        {crumbs.map((c, i) => (
          <span key={keyOf(c)}> › {i === crumbs.length - 1 ? <b>{c.name}</b> : <button type="button" className="link" onClick={() => onPick(spendPick(path.slice(0, i + 1)))}>{c.name}</button>}</span>
        ))}
      </nav>
      <table className="table spend-table">
        <thead><tr>
          <th>{top ? "Building" : (LEVEL_NAME[crumbs.length] ?? "Row")}</th><th>Sessions</th>{top ? <th title="Adjusted tokens the building used today (UTC)">Today</th> : null}
          <th>{ADJ}</th>{usd ? <th title="At API list price">$</th> : null}<th>Share</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => {
            const key = spendPick([...path, keyOf(r)]);
            const pick = pickRow(key, picked, (id) => onPick(id ?? (top ? null : spendPick(path))));
            const gl = grantLine(r);
            const t = today(r);
            return (
              <tr key={key} {...pick} className={[pick.className, `spend-${r.kind}`].join(" ")} title={NOTE_TITLE[r.kind] ? "Explained in the sidebar when picked" : r.id ?? undefined}>
                <td className="spend-name">{r.name}{r.children?.length ? <span className="muted spend-more" aria-hidden> ›</span> : null}{gl ? <GrantLine g={gl} /> : null}</td>
                <td>{r.sessions ? n(r.sessions) : "–"}</td>
                {top ? <td>{t === undefined ? "–" : fmtTokens(t)}</td> : null}
                <td className="spend-tokens">{n(r.tokens)}</td>
                {usd ? <td className="spend-usd muted">{r.usd === undefined ? "–" : dollars(r.usd)}</td> : null}
                <td className="spend-share muted">{pct(r.share)}</td>
              </tr>
            );
          })}
        </tbody>
        {!top ? <tfoot><tr><td>Total</td><td /><td className="spend-tokens"><b>{n(sum)}</b></td>{usd ? <td /> : null}<td /></tr></tfoot> : null}
      </table>
      {top ? <>
        <div className={check.ok ? "finance-check ok" : "error-line"} role="status">{check.ok ? "✓ " : "✗ "}{check.text}</div>
        {usdCheck ? <div className={usdCheck.ok ? "finance-check ok" : "error-line"} role="status">{usdCheck.ok ? "✓ " : "✗ "}{usdCheck.text}</div> : null}
        {grantsCheck ? <div className={grantsCheck.ok ? "finance-check ok" : "error-line"} role="status">{grantsCheck.ok ? "✓ " : "✗ "}{grantsCheck.text}</div> : null}
      </> : null}
      {crumbs.length === 1 && crumbs[0].kind === "building" ? <ManagerWakesLines mw={sp.managerWakes} buildingId={crumbs[0].id ?? "none"} /> : null}
      {top ? <LaneKind today={sp.byLaneKind} /> : crumbs.length === 1 && crumbs[0].kind === "building" ? <LaneKind today={sp.byLaneKind} buildingId={crumbs[0].id ?? "none"} name={crumbs[0].name} /> : null}
    </Section>
  );
}

/**
 * The sidebar's "Selected row" for a picked Spending row: its figures, then by kind a building's lanes over the last 24 h
 * and its own funding, a grant's spent vs funded and key results with a link to its page, an assignment's sessions (from
 * the grant's sessions), a synthetic row's note.
 */
export function SpendSelected({ sp, picked, bank, rev }: { sp: FinanceSpend; picked: string; bank: Bank | null; rev: number }) {
  const buildings = useTown((s) => s.buildings);
  const trail = spendTrail(sp.rows, picked);
  const node = trail[trail.length - 1];
  if (!node) return <p className="muted">That row is no longer listed.</p>;
  const parent = trail[trail.length - 2];
  const note = spendNotes(sp)[node.kind];
  const today = node.kind === "building" && node.id ? buildings.find((b) => b.id === node.id)?.budget?.tokensToday : undefined;
  const held = node.kind === "building" && node.id ? bank?.buildings.find((b) => b.buildingId === node.id)?.heldTokens : undefined;
  const gl = grantLine(node);
  return (
    <div className="spend-selected">
      <b>{node.name}</b>
      <table className="table">
        <tbody>
          <tr><td>Spent, all time</td><td>{n(node.tokens)} {ADJ}{node.usd !== undefined ? <span className="muted"> · {dollars(node.usd)}</span> : null}</td></tr>
          <tr><td>Share of used</td><td>{pct(node.share)}</td></tr>
          <tr><td>Sessions</td><td>{n(node.sessions)}</td></tr>
          {today !== undefined ? <tr><td>Spent today</td><td>{fmtTokens(today)}</td></tr> : null}
          {held ? <tr><td>Donated to it, unspent</td><td>{fmtTokens(held)}</td></tr> : null}
          {node.kind === "grant" && node.grantTokens !== undefined ? <tr><td>Granted</td><td>{node.grantTokens == null ? "not funded yet" : n(node.grantTokens)}</td></tr> : null}
          {node.children?.length ? <tr><td>{node.kind === "building" ? "Grants and other rows" : "Assignments and other rows"}</td><td>{n(node.children.length)}</td></tr> : null}
        </tbody>
      </table>
      {gl ? <p>{gl.spent} · {gl.outcome}{gl.over ? <> · <span className="spend-over">{gl.over}</span></> : null}{gl.krs ? <><br />{gl.krs}</> : null}</p> : null}
      {node.kind === "grant" && node.id ? <p>{node.objective ? <span className="muted">{node.objective} </span> : null}<a href={`#/grant/${node.id}`}>Open the grant page</a></p> : null}
      {node.kind === "building" && node.id ? <><BuildingLanes id={node.id} /><BuildingFunding rev={rev} buildingId={node.id} /></> : null}
      {node.kind === "assignment" && node.id && parent?.kind === "grant" && parent.id ? <AssignmentSessions grantId={parent.id} assignmentId={node.id} /> : null}
      {note ? <div className="bank-note">{typeof note === "string" ? <p className="muted">{note}</p> : note}</div> : null}
    </div>
  );
}

/** A building's spend over the last 24 h by lane (GET /api/goals/gl_town/spend?days=1, its byBuilding row). */
function BuildingLanes({ id }: { id: string }) {
  const r = useLoad(() => api().goalSpend(ROOT_GOAL_ID, 1), []);
  if (!r.data) return r.loading ? <Loading /> : null;
  const b = r.data.byBuilding.find((x) => x.id === id);
  return <p><span className="muted">Last 24 h by lane:</span> {b ? `${laneLine(b.byLane)} (${n(b.sessions)} session${b.sessions === 1 ? "" : "s"})` : "nothing"}</p>;
}

/** An assignment's sessions, newest first, from its grant's sessions (GET /api/sessions?grantId=). */
function AssignmentSessions({ grantId, assignmentId }: { grantId: string; assignmentId: string }) {
  const r = useLoad(() => api().grantSessions(grantId), [grantId]);
  if (!r.data) return r.loading ? <Loading /> : null;
  const rows = r.data.sessions.filter((s) => s.assignmentId === assignmentId);
  if (!rows.length) return <p className="muted">No sessions listed for it.</p>;
  return (
    <table className="table spend-sessions">
      <thead><tr><th>Started (UTC)</th><th>Who</th><th>{ADJ}</th><th>$</th></tr></thead>
      <tbody>{rows.map((s) => (
        <tr key={s.id} title={`${s.status} · ${s.model}`}><td>{s.startedAt.slice(0, 16).replace("T", " ")}</td><td>{s.agentName}</td><td>{n(s.adjustedOutputTokens)}</td><td>{dollars(s.usd)}</td></tr>
      ))}</tbody>
    </table>
  );
}

const perDecision = (l: ManagerWakeLine) => (l.perDecision === null ? "no decisions" : `${fmtTokens(l.perDecision)} per decision`);
/** One manager-wakes line in words: "4 wakes · 160k adj. tokens · $3.20 · 40k per wake · 4 decided, 40k per decision". */
export function wakeLine(l: ManagerWakeLine): string {
  return `${n(l.wakes)} wake${l.wakes === 1 ? "" : "s"} · ${fmtTokens(l.tokens)} ${ADJ} · ${dollars(l.usd)} · ${fmtTokens(l.perWake)} per wake · ${n(l.decided)} decided, ${perDecision(l)}`;
}
const WAKE_FOLD = 7;

/**
 * Manager wakes per day in a building's level of the drill-down (gr_lwgus14rd2 step 3, kr_avafh64h02): GET
 * /api/finance/spend's `managerWakes`, one line per UTC day (wakes, adj. tokens, $, per wake, decided, per decision),
 * newest first, folded to the newest 7 days, then the window total (7 full days and today).
 */
export function ManagerWakesLines({ mw, buildingId, initialOpen = false }: { mw?: ManagerWakes; buildingId: string; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  if (!mw) return null;
  const b = mw.buildings[buildingId];
  const days = b ? (open ? b.days : b.days.slice(0, WAKE_FOLD)) : [];
  return (
    <section className="manager-wakes" aria-label="Manager wakes per day">
      <b>Manager wakes</b> <span className="muted">· {mw.windowNote}; decided = reports and flags the manager decided inside a wake</span>
      {b ? (
        <table className="table spend-table manager-wakes-table">
          <thead><tr><th>Day (UTC)</th><th>Wakes</th><th>{ADJ}</th><th title="At API list price">$</th><th>Per wake</th><th>Decided</th><th>Per decision</th></tr></thead>
          <tbody>
            {days.map((d) => <WakeRow key={d.day} label={d.day} l={d} />)}
            {b.days.length > WAKE_FOLD ? <tr><td colSpan={7}><button type="button" className="link" aria-expanded={open} onClick={() => setOpen((x) => !x)}>{open ? "Show the newest 7 days" : `Show ${b.days.length - WAKE_FOLD} more day${b.days.length - WAKE_FOLD === 1 ? "" : "s"}`}</button></td></tr> : null}
          </tbody>
          <tfoot><WakeRow label="7 d total" l={b.total} bold /></tfoot>
        </table>
      ) : <p className="muted">No manager wakes in this window.</p>}
    </section>
  );
}

function WakeRow({ label, l, bold }: { label: string; l: ManagerWakeLine; bold?: boolean }) {
  return (
    <tr className="manager-wake-day">
      <td>{bold ? <b>{label}</b> : label}</td><td>{n(l.wakes)}</td><td className="spend-tokens">{fmtTokens(l.tokens)}</td>
      <td className="spend-usd muted">{dollars(l.usd)}</td><td>{fmtTokens(l.perWake)}</td><td>{n(l.decided)}</td>
      <td>{l.perDecision === null ? "–" : fmtTokens(l.perDecision)}</td>
    </tr>
  );
}

/**
 * The Spending sidebar's "Health": drift (adjusted vs SDK-reported cost, 24 h) and out-of-tokens deaths and the cap. The
 * lane × token-kind table (gr_lwgus14rd2) sits under the drill-down instead (`LaneKind`): it is too wide for the sidebar.
 */
export function SpendingHealth({ bank, wakes }: { bank: Bank | null; wakes?: ManagerWakes }) {
  const drift = bank?.drift && bank.drift.models.length ? bank.drift : null;
  const deaths = bank?.deaths && bank.cap ? { d: bank.deaths, cap: bank.cap } : null;
  if (!drift && !deaths && !wakes) return null;
  return (
    <section className="bank-health">
      <h4>Health</h4>
      {wakes ? <p className="manager-wakes-total" title={`${wakes.windowNote}; open a building for its days`}><b>Manager wakes, 7 d:</b> {wakeLine(wakes.total)}</p> : null}
      {drift ? (
        <table className="table" aria-label={`Drift (${drift.day}, 24 h)`}>
          <thead><tr><th>Drift ({drift.day}, 24 h)</th><th /></tr></thead>
          <tbody>
            {drift.models.map((r) => (
              <tr key={r.model ?? ""} title={`$${r.adjustedUsd.toFixed(2)} adjusted vs $${r.costUsd.toFixed(2)} SDK · ${r.sessions} session${r.sessions === 1 ? "" : "s"}${r.backfilled ? ` · ${r.backfilled} back-filled left out` : ""}`}>
                <td>{r.model}</td>
                <td style={r.ratio !== null && Math.abs(r.ratio - 1) > 0.1 ? { color: "#c0392b" } : undefined}>drift: {r.ratio === null ? "n/a" : r.ratio.toFixed(2)} (24 h)</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {deaths ? (
        <table className="table" aria-label="Out-of-tokens deaths and the cap">
          <tbody>
            <tr title={deaths.d.events.map((e) => `${e.ts.slice(0, 16).replace("T", " ")} ${e.kind}: ${e.text}`).join("\n")}>
              <td>Unexpected out-of-tokens deaths, last 7 days (baseline 7, target 0)</td>
              <td style={deaths.d.total ? { color: "#c0392b" } : undefined}><b>{deaths.d.total}</b> (cap {deaths.d.capDeaths}, exhausted {deaths.d.exhausted})</td>
            </tr>
            <tr className="sub-row"><td>Subscription spend today</td><td>{fmtTokens(deaths.cap.spentToday)}</td></tr>
            {deaths.cap.cappedAt ? <tr><td>Subscription</td><td style={{ color: "#c0392b" }}>capped since {deaths.cap.cappedAt.slice(0, 16).replace("T", " ")} UTC, resets {deaths.cap.resetsAt.slice(0, 16).replace("T", " ")} UTC</td></tr> : null}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

const LANE_LABEL: Record<LaneKindRow["lane"], string> = {
  grant: "Grant", exploration: "Exploration", directed: "Directed", retainer: "Retainer", manager: "Manager wakes", other: "Other", total: "Total",
};
const LANE_HINT: Partial<Record<LaneKindRow["lane"], string>> = {
  manager: "A manager's team-lead sessions (purpose manage)",
  other: "Reviews, meetings, summaries, naming, estimates, and work with no lane recorded",
};
const KIND_COLS: [TokenKind, string, string][] = [["input", "Input", "Input"], ["output", "Output", "Output"], ["cacheRead", "Cache read", "Cache read"], ["cacheWrite5m", "Write 5 min", "Cache write 5 min"], ["cacheWrite1h", "Write 1 h", "Cache write 1 h"]];

/**
 * Spend by lane × token kind (gr_lwgus14rd2 step 1, kr_pzr1fkgas8): GET /api/finance/spend's `byLaneKind`, the town's
 * at the top level and one building's (its `buildings` entry) in that building's level. One summary line (total, $, the
 * cache-write share of cost) with a today / 7 d toggle; the table folds under "Show the table" so each level stays about
 * one screen. Today comes with the tab's spend; 7 d is fetched when picked. Totals ($, share) come first and the table
 * scrolls sideways inside its own box: the Spending column is ~710 px at 1400 px, narrower than the ten columns.
 */
export function LaneKind({ today, buildingId, name, initialOpen = false }: { today?: SpendByLaneKind; buildingId?: string; name?: string; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [win, setWin] = useState<"today" | "7d">("today");
  const week = useLoad(() => (win === "7d" ? api().financeSpend("7d") : Promise.resolve(null)), [win]);
  if (!today) return null;
  const lk = win === "today" ? today : week.data?.byLaneKind;
  const t: LaneKindTable | undefined = lk && (buildingId ? lk.buildings[buildingId] ?? { rows: [], total: { ...lk.total, sessions: 0, tokens: 0, usd: 0, cacheWriteShare: 0 }, notCounted: { sessions: 0, tokens: 0, usd: 0 } } : lk);
  const winBtn = (w: "today" | "7d", label: string) => <button type="button" className="btn sm bank-toggle" aria-pressed={win === w} onClick={() => setWin(w)}>{label}</button>;
  return (
    <section className="lane-kind" aria-label="Spend by lane and token kind">
      <div className="lane-kind-head">
        <span><b>By lane × token kind</b>{name ? ` · ${name}` : ""}{lk ? <span className="muted"> · {lk.windowNote}</span> : null}{t ? <>: {n(t.total.tokens)} {ADJ} · {dollars(t.total.usd)} · cache writes {pct(t.total.cacheWriteShare)} of cost</> : week.loading ? <Loading /> : null}</span>
        <span className="bank-section-right">{winBtn("today", "Today")}{winBtn("7d", "7 d")}<button type="button" className="btn sm bank-toggle" aria-expanded={open} onClick={() => setOpen((x) => !x)}>{open ? "Hide the table" : "Show the table"}</button></span>
      </div>
      {open && t ? (
        <div className="lane-kind-scroll">
        <table className="table spend-table lane-kind-table">
          <thead><tr>
            <th>Lane</th><th>Sessions</th>
            <th>{ADJ}</th><th title="At API list price">$</th><th title="Cache write 5 min + 1 h, share of the row's cost">Cache-write share</th>
            {KIND_COLS.map(([k, label, long]) => <th key={k} title={`${long}, ${ADJ} (≈ $ on hover)`}>{label}</th>)}
          </tr></thead>
          <tbody>{t.rows.length ? t.rows.map((r) => <LaneKindLine key={r.lane} r={r} />) : <tr><td colSpan={10} className="muted">No sessions in this window.</td></tr>}</tbody>
          {t.rows.length > 1 ? <tfoot><LaneKindLine r={t.total} /></tfoot> : null}
        </table>
        </div>
      ) : null}
      {open && t?.notCounted.sessions ? <p className="muted">Not counted: {n(t.notCounted.sessions)} back-filled session{t.notCounted.sessions === 1 ? "" : "s"} with no real split by kind, {n(t.notCounted.tokens)} {ADJ} ({dollars(t.notCounted.usd)}).</p> : null}
      {open && lk && !buildingId ? <div className={lk.check.ok ? "finance-check ok" : "error-line"} role="status">{lk.check.ok ? "✓ " : "✗ "}{lk.check.identity}: {n(lk.total.tokens + lk.notCounted.tokens)} vs {n(lk.sessionsTokens)}</div> : null}
    </section>
  );
}

function LaneKindLine({ r }: { r: LaneKindRow }) {
  return (
    <tr className={`lane-kind-${r.lane}`} title={LANE_HINT[r.lane]}>
      <td>{r.lane === "total" ? <b>{LANE_LABEL[r.lane]}</b> : LANE_LABEL[r.lane]}</td>
      <td>{n(r.sessions)}</td>
      <td className="spend-tokens">{fmtTokens(r.tokens)}</td>
      <td className="spend-usd muted">{dollars(r.usd)}</td>
      <td>{pct(r.cacheWriteShare)}</td>
      {KIND_COLS.map(([k]) => <td key={k} title={dollars(r.kinds[k].usd)}>{fmtTokens(r.kinds[k].tokens)}</td>)}
    </tr>
  );
}
