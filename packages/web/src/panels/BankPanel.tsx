/**
 * The Bank's tab bodies (BankSheet.tsx is the sheet over the map that shows them; the HUD's "$", `#/bank`, the old `#/finance`): the town's tokens (1:1 mt_ew2d0mm7h9),
 * public, in tabs, each a thing in the Bank's room (BANK_FIXTURES: walk up or tap it to open its tab). Donate (the chest; the
 * tab the sheet opens on): the Donate form, then what funds the town now. Balance (the vault): the balance with one "Free for
 * exploration" line (its sum in the sidebar; per-goal free tokens are in the goal editor), Next 30 days, top contributors.
 * Inputs (ledger desk): Tokens, Bank inputs, Streams, Sources. Spending (spending board): building funding, Spending, Spend by goal (a
 * goal's subtree from session rows; 1:1 mt_n25udpflus decision 5), drift, out-of-tokens deaths and the cap. Hosting (server rack): Fly.io in dollars. The funding sections are BankFunding's, the finance ones
 * BankFinance's, each over its own endpoint.
 */
import { useState, type ReactNode } from "react";
import { api, type Bank } from "../api";
import { useTown } from "../state";
import { BankContributors, BankInputs, BankInputsAbout, BankStreamsSection, BuildingFunding, Donate, DonateAbout, FundingNow } from "./BankFunding";
import { FinanceFooter, FinanceIntro, InputCredits, FinanceTerms, FlyAbout, FlyView, ProjectionAbout, ProjectionView, SourcesAbout, SourcesView, SpendingAbout, SpendingView, TokensAbout, TokensView, type FinanceData } from "./BankFinance";
import { FreeTokensSum } from "./FreeTokens";
import { SpendByGoal } from "./GoalSpend";
import { ADJ, Act, Loading, NumberInput, Section, breakdownTitle, fmtTokens } from "./ui";
import { claimedTokens } from "../format";

type ViewProps = { tab: string; bank: Bank | null; fin: FinanceData | null; rev: number; onChange: () => void; onReload: () => void };
/** The row picked in the centre (a Bank input's id on Inputs), shown in the sidebar's "Selected row"; null = none. */
type PickProps = { picked: string | null; onPick: (id: string | null) => void };

/**
 * One tab of the Bank sheet given its data: `bank` from GET /api/bank (null until loaded), `fin` the finance endpoints (null
 * until loaded). The centre column (`.bank-main`) holds the tab's tables only; every explanation sits in the sidebar
 * (`.bank-side`): "About this tab" (`BankAbout`, the tab's prose), the Terms and where the numbers come from, then the
 * selected row: a row picked in the centre (on Inputs a Bank input: its dated credits, InputCredits; gr_567tikzitl step 3), or
 * `selected` when the caller gives one. `picked` is the row picked at first (tests). `divider` (the sheet's drag handle)
 * goes between the two columns.
 */
export function BankView(props: ViewProps & { head?: ReactNode; divider?: ReactNode; selected?: ReactNode; picked?: string | null }) {
  const { divider, head, picked: first, ...view } = props;
  const [picked, onPick] = useState<string | null>(first ?? null);
  const selected = props.selected ?? (picked && view.tab === "Inputs" ? <InputCredits id={picked} sources={view.fin?.sources ?? null} bank={view.bank} /> : null);
  return (
    <>
      <div className="bank-main" aria-label="The tab's tables">{head}<BankTab {...view} picked={picked} onPick={onPick} /></div>
      {divider}
      <aside className="bank-side" aria-label="About this tab">
        {selected ? <section className="bank-selected"><h4>Selected row</h4>{selected}</section> : null}
        <h4>About this tab</h4>
        <BankAbout {...view} />
        <FinanceTerms />
        {props.fin ? <FinanceFooter {...props.fin} /> : null}
      </aside>
    </>
  );
}

/** The tab's prose (the sidebar's "About this tab"), in the order its sections sit in the centre. */
function BankAbout({ tab, bank, fin }: ViewProps) {
  if (tab === "Donate") return <DonateAbout />;
  if (tab === "Inputs") return <>{bank || fin?.sources ? <InputsAbout /> : null}{fin ? <TokensAbout f={fin.f} /> : null}{bank ? <BankInputsAbout /> : null}{fin?.sources ? <SourcesAbout /> : null}</>;
  if (tab === "Spending") return (
    <>
      {fin?.spend ? <SpendingAbout sp={fin.spend} /> : null}
      {bank?.drift && bank.drift.models.length ? <p className="muted">Drift: adjusted output tokens × output list price vs what the SDK says the sessions cost. Target 0.90–1.10.</p> : null}
    </>
  );
  if (tab === "Hosting") return fin?.fly ? <FlyAbout fly={fin.fly} /> : <p className="muted">No hosting figures yet.</p>;
  return <><FinanceIntro hosting={!!fin?.fly} />{bank?.free ? <FreeTokensSum free={bank.free} /> : null}{fin ? <ProjectionAbout f={fin.f} /> : null}</>;
}

/** How to read the Inputs tab's lists (gr_567tikzitl step 3, kr_y7derda40x). */
const InputsAbout = () => <p className="muted">Each list shows the active inputs only; &ldquo;Show N cancelled&rdquo; beside its title brings back the cancelled ones (and on Sources, &ldquo;Show N retired&rdquo; the retired donations). The totals count them all. Click an input for its dated credits here.</p>;

function BankTab({ tab, bank, fin, rev, onChange, onReload, picked, onPick }: ViewProps & PickProps) {
  if (tab === "Donate") return (
    <>
      <Donate onChange={onChange} />
      <FundingNow bank={bank} rev={rev} />
    </>
  );
  if (tab === "Inputs") return (
    <>
      {fin ? <TokensView f={fin.f} /> : null}
      {bank ? <BankInputs bank={bank} onChange={onReload} selected={picked} onSelect={onPick} /> : null}
      {bank ? <BankStreamsSection rev={bank.inputs.length} /> : null}
      {fin?.sources ? <SourcesView s={fin.sources} selected={picked} onSelect={onPick} /> : null}
    </>
  );
  if (tab === "Spending") return <BankSpending bank={bank} fin={fin} rev={rev} />;
  if (tab === "Hosting") return fin?.fly ? <FlyView fly={fin.fly} /> : null;
  return (
    <>
      <Section title="Balance">
        {!bank ? <Loading /> : (
          <table className="table" title={breakdownTitle(bank.creditedCounts)}>
            <thead><tr><th /><th>{ADJ}</th></tr></thead>
            <tbody>
              <tr><td>Town total (Bank + held by buildings)</td><td><b>{bank.townTokens.toLocaleString("en-US")}</b></td></tr>
              <tr><td>In the Bank (one balance every building draws on)</td><td>{bank.balanceTokens.toLocaleString("en-US")}</td></tr>
              <tr><td>Claimed (open reservations + open proposals&apos; asks + funded grants&apos; remaining)</td><td>{bank.free ? claimedTokens(bank.free).toLocaleString("en-US") : "…"}</td></tr>
              {bank.reserveTokens !== undefined ? <OperatingReserveRow bank={bank} onChange={onReload} /> : null}
              <tr title="What exploration (work no grant covers and no human asked for) or a new grant may still claim; the sum is in the sidebar"><td>Free for exploration</td><td><b>{bank.free ? bank.free.freeTokens.toLocaleString("en-US") : "…"}</b></td></tr>
              {bank.free?.overdraftTokens ? <tr title="Approved claims the usable balance doesn't cover; the sidebar lists them"><td style={{ color: "#c0392b" }}>Overdraft: claimed, not backed by anything usable</td><td style={{ color: "#c0392b" }}>{bank.free.overdraftTokens.toLocaleString("en-US")}</td></tr> : null}
              <tr><td>Expected inflow per day</td><td>{fmtTokens(bank.dailyInflowTokens)}</td></tr>
              <tr className="sub-row" title={breakdownTitle(bank.creditedCounts)}><td>Credited so far: input · output · cache read · cache write 5m · 1h (raw)</td><td>{[bank.creditedCounts.input, bank.creditedCounts.output, bank.creditedCounts.cacheRead, bank.creditedCounts.cacheWrite5m, bank.creditedCounts.cacheWrite1h].map(fmtTokens).join(" · ")}</td></tr>
            </tbody>
          </table>
        )}
      </Section>
      {fin ? <ProjectionView f={fin.f} /> : null}
      {bank ? <BankContributors bank={bank} /> : null}
    </>
  );
}

/**
 * "Operating reserve: 500,000 (left above it: N)" (1:1 mt_lb7tm75jgb): the part of the balance exploration and grant
 * funding can't claim and work sessions of every lane wait at, so manager sessions (deciding reports, 1:1s, meetings) keep running (2026-11-02). An admin edits it here (PUT /api/town/operating-reserve).
 */
function OperatingReserveRow({ bank, onChange }: { bank: Bank; onChange: () => void }) {
  const admin = useTown((s) => !!s.me?.isAdmin);
  const reserve = bank.reserveTokens ?? 0;
  const [editing, setEditing] = useState<number | null>(null);
  const above = bank.balanceTokens - reserve;
  return (
    <tr title="Kept for manager sessions (deciding reports, 1:1s, meetings), which run on it down to 0; work sessions of every lane wait while the balance is within it, and exploration and grant funding can't claim it">
      <td>Operating reserve (kept for manager sessions: deciding reports, 1:1s, meetings)</td>
      <td>
        {editing === null ? <>
          <b>{reserve.toLocaleString("en-US")}</b> <span className="muted">(left above it: {above.toLocaleString("en-US")})</span>
          {admin ? <> <button type="button" className="btn sm" onClick={() => setEditing(reserve)}>Edit</button></> : null}
        </> : <>
          <NumberInput aria-label="Operating reserve in tokens" min={0} step={50_000} value={editing} onChange={setEditing} style={{ width: 120 }} />
          {" "}<Act small tone="primary" run={async () => { await api().setOperatingReserve(editing); setEditing(null); onChange(); }}>Save</Act>
          {" "}<button type="button" className="btn sm" onClick={() => setEditing(null)}>Cancel</button>
        </>}
      </td>
    </tr>
  );
}

/** The Spending tab: what each building was given and spent, spend by goal, then the Bank's health (drift, out-of-tokens deaths and the cap). */
function BankSpending({ bank, fin, rev }: { bank: Bank | null; fin: FinanceData | null; rev: number }) {
  return (
    <>
      {bank ? <BuildingFunding rev={rev} /> : null}
      {fin?.spend ? <SpendingView sp={fin.spend} /> : null}
      <SpendByGoal />
      {bank?.drift && bank.drift.models.length ? (
        <Section title={`Drift (${bank.drift.day}, 24 h)`}>
          <table className="table">
            <tbody>
              {bank.drift.models.map((r) => (
                <tr key={r.model ?? ""} title={`$${r.adjustedUsd.toFixed(2)} adjusted vs $${r.costUsd.toFixed(2)} SDK · ${r.sessions} session${r.sessions === 1 ? "" : "s"}${r.backfilled ? ` · ${r.backfilled} back-filled left out` : ""}`}>
                  <td>{r.model}</td>
                  <td style={r.ratio !== null && Math.abs(r.ratio - 1) > 0.1 ? { color: "#c0392b" } : undefined}>drift: {r.ratio === null ? "n/a" : r.ratio.toFixed(2)} (24 h)</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}
      {bank?.deaths && bank.cap ? (
        <Section title="Out-of-tokens deaths and the cap">
          <table className="table">
            <tbody>
              <tr title={bank.deaths.events.map((e) => `${e.ts.slice(0, 16).replace("T", " ")} ${e.kind}: ${e.text}`).join("\n")}>
                <td>Unexpected out-of-tokens deaths, last 7 days (baseline 7, target 0)</td>
                <td style={bank.deaths.total ? { color: "#c0392b" } : undefined}><b>{bank.deaths.total}</b> (cap {bank.deaths.capDeaths}, exhausted {bank.deaths.exhausted})</td>
              </tr>
              <tr className="sub-row"><td>Subscription spend today</td><td>{fmtTokens(bank.cap.spentToday)}</td></tr>
              {bank.cap.cappedAt ? <tr><td>Subscription</td><td style={{ color: "#c0392b" }}>capped since {bank.cap.cappedAt.slice(0, 16).replace("T", " ")} UTC, resets {bank.cap.resetsAt.slice(0, 16).replace("T", " ")} UTC</td></tr> : null}
            </tbody>
          </table>
        </Section>
      ) : null}
    </>
  );
}
