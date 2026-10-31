/**
 * The Bank (south of the road; also the HUD's "$", `#/bank` and the old `#/finance`): the town's tokens (1:1 mt_ew2d0mm7h9),
 * public, in tabs, each a thing in the Bank's room (BANK_FIXTURES: walk up or tap it to open its tab). Overview (the vault):
 * Balance, Next 30 days, top contributors, Donate. Tokens & sources (ledger desk): Tokens, Bank inputs, Sources. Pools
 * (fountain): the pools and their balances. Spending (spending board): building funding, Spending, Spend by goal (a
 * goal's subtree from session rows; 1:1 mt_n25udpflus decision 5), drift, out-of-tokens deaths and the cap. Hosting (server rack): Fly.io in dollars. The funding sections are BankFunding's, the finance ones
 * BankFinance's, each over its own endpoint.
 */
import { useState } from "react";
import { BANK_TABS } from "@muster-town/schema";
import { api, type Bank } from "../api";
import { store, useTown } from "../state";
import { Glyph, PanelShell } from "./PanelShell";
import { BankContributors, BankInputs, BankPools, BankStreamsSection, BuildingFunding, Donate } from "./BankFunding";
import { FinanceFooter, FinanceIntro, FinanceTerms, FlyView, PoolsView, ProjectionView, SourcesView, SpendingView, TokensView, useFinance, type FinanceData } from "./BankFinance";
import { SpendByGoal } from "./GoalSpend";
import { ADJ, ErrorLine, Loading, Section, breakdownTitle, fmtTokens } from "./ui";

/** Refetch the summary the sign and these sections read. */
const reload = () => { api().bank().then((bank) => store.set({ bank }), () => undefined); };

export function BankPanel({ tab }: { tab?: string }) {
  const bank = useTown((s) => s.bank);
  const fin = useFinance();
  const [rev, setRev] = useState(0);
  const changed = () => { reload(); setRev((r) => r + 1); };
  return (
    <PanelShell icon={<Glyph kind="bank" />} title="The Bank" subtitle="The town's tokens: what came in, where they went and what is left; hosting in dollars"
      tabs={[...BANK_TABS]} initialTab={tab && (BANK_TABS as readonly string[]).includes(tab) ? tab : "Overview"}>
      {(t) => <>
        {fin.loading && !fin.data ? <Loading /> : null}
        <ErrorLine error={fin.error} />
        <BankView tab={t} bank={bank} fin={fin.data} rev={rev} onChange={changed} onReload={reload} />
      </>}
    </PanelShell>
  );
}

type ViewProps = { tab: string; bank: Bank | null; fin: FinanceData | null; rev: number; onChange: () => void; onReload: () => void };

/** One tab of the page given its data: `bank` from GET /api/bank (null until loaded), `fin` the finance endpoints (null until loaded); each tab ends with the Terms block and where its numbers come from. */
export function BankView(props: ViewProps) {
  return <><BankTab {...props} /><FinanceTerms />{props.fin ? <FinanceFooter {...props.fin} /> : null}</>;
}

function BankTab({ tab, bank, fin, rev, onChange, onReload }: ViewProps) {
  if (tab === "Tokens & sources") return (
    <>
      {fin ? <TokensView f={fin.f} /> : null}
      {bank ? <BankInputs bank={bank} onChange={onReload} /> : null}
      {bank ? <BankStreamsSection rev={bank.inputs.length} /> : null}
      {fin?.sources ? <SourcesView s={fin.sources} /> : null}
    </>
  );
  if (tab === "Pools") return (
    <>
      {bank ? <BankPools bank={bank} onChange={onReload} /> : null}
      {fin?.poolsFin ? <PoolsView fp={fin.poolsFin} /> : null}
    </>
  );
  if (tab === "Spending") return <BankSpending bank={bank} fin={fin} rev={rev} />;
  if (tab === "Hosting") return fin?.fly ? <FlyView fly={fin.fly} /> : <p className="muted">No hosting figures yet.</p>;
  return (
    <>
      <FinanceIntro hosting={!!fin?.fly} />
      <Section title="Balance">
        {!bank ? <Loading /> : (
          <table className="table" title={breakdownTitle(bank.creditedCounts)}>
            <thead><tr><th /><th>{ADJ}</th></tr></thead>
            <tbody>
              <tr><td>Town total (Bank + held by buildings)</td><td><b>{bank.townTokens.toLocaleString("en-US")}</b></td></tr>
              <tr><td>In the Bank (split between pools)</td><td>{bank.balanceTokens.toLocaleString("en-US")}</td></tr>
              <tr><td>Expires today (daily allowance, no rollover)</td><td>{bank.expiringTokens.toLocaleString("en-US")}</td></tr>
              <tr><td>Permanent (stays until spent)</td><td>{bank.durableTokens.toLocaleString("en-US")}</td></tr>
              <tr><td>Held by buildings (donated to one building)</td><td>{bank.heldTokens.toLocaleString("en-US")}</td></tr>
              {bank.heldByAuth ? <>
                <tr className="sub-row"><td>of which subscription</td><td>{bank.heldByAuth.subscription.toLocaleString("en-US")}</td></tr>
                <tr className="sub-row"><td>of which API key</td><td>{bank.heldByAuth.apiKey.toLocaleString("en-US")}</td></tr>
                {bank.heldByAuth.donorKey ? <tr className="sub-row"><td>of which donors' own keys</td><td>{bank.heldByAuth.donorKey.toLocaleString("en-US")}</td></tr> : null}
              </> : null}
              <tr><td>Expected inflow per day</td><td>{fmtTokens(bank.dailyInflowTokens)}</td></tr>
              <tr className="sub-row" title={breakdownTitle(bank.creditedCounts)}><td>Credited so far: input · output · cache read · cache write 5m · 1h (raw)</td><td>{[bank.creditedCounts.input, bank.creditedCounts.output, bank.creditedCounts.cacheRead, bank.creditedCounts.cacheWrite5m, bank.creditedCounts.cacheWrite1h].map(fmtTokens).join(" · ")}</td></tr>
            </tbody>
          </table>
        )}
      </Section>
      {fin ? <ProjectionView f={fin.f} /> : null}
      {bank && <>
        <BankContributors bank={bank} />
        <Donate onChange={onChange} />
      </>}
    </>
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
          <p className="muted">Adjusted output tokens × output list price vs what the SDK says the sessions cost. Target 0.90–1.10.</p>
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
              <tr><td>Learned subscription cap per day</td><td>{bank.cap.learnedCap === null ? "no cap seen" : `${fmtTokens(bank.cap.learnedCap)} (median of ${bank.cap.days} day${bank.cap.days === 1 ? "" : "s"})`}</td></tr>
              <tr className="sub-row"><td>Subscription spend today · typical session</td><td>{fmtTokens(bank.cap.spentToday)} · {bank.cap.typicalSession === null ? "n/a" : fmtTokens(bank.cap.typicalSession)}</td></tr>
              {bank.cap.held ? <tr><td>New subscription starts</td><td style={{ color: "#c0392b" }}>held: {bank.cap.reason}</td></tr> : null}
            </tbody>
          </table>
        </Section>
      ) : null}
    </>
  );
}
