/**
 * The Bank (its teller counter, south of the road; also the HUD's "$", `#/bank` and the old `#/finance`): one page for the
 * town's tokens (1:1 mt_ew2d0mm7h9), public. In order: what is available now (Balance) and all time (Tokens, Next 30 days);
 * where tokens come from (contributors, the one Donate form, Bank inputs, Sources); how they are divided (pools, building
 * allocations, pool balances); where they go (Spending, Hosting (Fly.io) in dollars); then the Bank's health (drift, deaths
 * and the cap). The funding sections are BankFunding's, the finance ones BankFinance's, each over its own endpoint.
 */
import { useState } from "react";
import { api, type Bank } from "../api";
import { store, useTown } from "../state";
import { Glyph, PanelShell } from "./PanelShell";
import { BankContributors, BankInputs, BankPools, BuildingFunding, Donate } from "./BankFunding";
import { FinanceFooter, FinanceIntro, FlyView, PoolsView, ProjectionView, SourcesView, SpendingView, TokensView, useFinance, type FinanceData } from "./BankFinance";
import { ADJ, ErrorLine, Loading, Section, breakdownTitle, fmtTokens } from "./ui";

/** Refetch the summary the sign and these sections read. */
const reload = () => { api().bank().then((bank) => store.set({ bank }), () => undefined); };

export function BankPanel() {
  const bank = useTown((s) => s.bank);
  const fin = useFinance();
  const [rev, setRev] = useState(0);
  const changed = () => { reload(); setRev((r) => r + 1); };
  return (
    <PanelShell icon={<Glyph kind="bank" />} title="The Bank" subtitle="The town's tokens: what came in, where they went and what is left; hosting in dollars">
      {fin.loading && !fin.data ? <Loading /> : null}
      <ErrorLine error={fin.error} />
      <BankView bank={bank} fin={fin.data} rev={rev} onChange={changed} onReload={reload} />
    </PanelShell>
  );
}

/** The page given its data: `bank` from GET /api/bank (null until loaded), `fin` the finance endpoints (null until loaded). */
export function BankView({ bank, fin, rev, onChange, onReload }: { bank: Bank | null; fin: FinanceData | null; rev: number; onChange: () => void; onReload: () => void }) {
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
      {fin ? <TokensView f={fin.f} /> : null}
      {fin ? <ProjectionView f={fin.f} /> : null}
      {bank && <>
        <BankContributors bank={bank} />
        <Donate onChange={onChange} />
        <BankInputs bank={bank} onChange={onReload} />
      </>}
      {fin?.sources ? <SourcesView s={fin.sources} /> : null}
      {bank && <>
        <BankPools bank={bank} onChange={onReload} />
        <BuildingFunding rev={rev} />
      </>}
      {fin?.poolsFin ? <PoolsView fp={fin.poolsFin} /> : null}
      {fin?.spend ? <SpendingView sp={fin.spend} /> : null}
      {fin?.fly ? <FlyView fly={fin.fly} /> : null}
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
      {fin ? <FinanceFooter {...fin} /> : null}
    </>
  );
}
