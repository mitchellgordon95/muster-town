/**
 * The Bank, in tabs (Mitchell, 1:1 mt_ew2d0mm7h9): each tab is a thing in the Bank's room (BANK_FIXTURES), so walking
 * up to it and pressing E (or tapping it) opens its tab. Balance (the vault), Donate (donation box: the one Donate form
 * and the top contributors), Inputs (ticker: Bank inputs and where tokens came from), Pools (fountain: pool sizes and
 * what each drew), Health (pressure gauge: price drift, out-of-tokens deaths and the cap), Ledger (ledger desk: the
 * finance totals, 30-day projection and spending tree, which the HUD's "$" and `#/finance` open), Funding (lockboxes:
 * building allocations) and Hosting (server rack: what the Fly.io Machines cost).
 */
import { useState, type ReactNode } from "react";
import { BANK_TABS } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { Glyph, PanelShell } from "./PanelShell";
import { BankContributors, BankInputs, BankPools, BuildingFunding, Donate } from "./BankFunding";
import { FinanceView, FlyView, PoolsView, SourcesView } from "./FinancePanel";
import { ADJ, Empty, ErrorLine, Loading, Section, breakdownTitle, fmtTokens, useLoad } from "./ui";

/** Refetch the summary the sign and these sections read. */
const reload = () => { api().bank().then((bank) => store.set({ bank }), () => undefined); };

export function BankPanel({ tab }: { tab?: string }) {
  const bank = useTown((s) => s.bank);
  const [rev, setRev] = useState(0);
  const changed = () => { reload(); setRev((r) => r + 1); };
  const tabs: string[] = [...BANK_TABS];
  return (
    <PanelShell icon={<Glyph kind="bank" />} title="The Bank" subtitle="Adjusted output tokens (adj. tokens) available to the town" tabs={tabs} initialTab={tab && tabs.includes(tab) ? tab : "Balance"}>
      {(t) => !bank && t !== "Ledger" && t !== "Hosting" ? <Loading /> : (
        <>
          {t === "Balance" && bank ? <Balance /> : null}
          {t === "Donate" && bank ? <><Donate onChange={changed} /><BankContributors bank={bank} /></> : null}
          {t === "Inputs" && bank ? <><BankInputs bank={bank} onChange={reload} /><Loaded load={() => api().financeSources()}>{(s) => <SourcesView s={s} />}</Loaded></> : null}
          {t === "Pools" && bank ? <><BankPools bank={bank} onChange={reload} /><Loaded load={() => api().financePools()}>{(fp) => <PoolsView fp={fp} />}</Loaded></> : null}
          {t === "Health" ? <Health /> : null}
          {t === "Ledger" ? <Loaded load={() => Promise.all([api().finance(), api().financeSpend().catch(() => null)])}>{([f, spend]) => <FinanceView f={f} pools={null} spend={spend} />}</Loaded> : null}
          {t === "Funding" ? <BuildingFunding rev={rev} /> : null}
          {t === "Hosting" ? <Loaded load={() => api().financeFly()}>{(fly) => <FlyView fly={fly} />}</Loaded> : null}
        </>
      )}
    </PanelShell>
  );
}

/** A tab's data from one fetch: loading, then the error or the view. */
function Loaded<T>({ load, children }: { load: () => Promise<T>; children: (d: T) => ReactNode }) {
  const d = useLoad(load, []);
  return <>{d.loading && !d.data ? <Loading /> : null}<ErrorLine error={d.error} />{d.data ? children(d.data) : null}</>;
}

function Balance() {
  const bank = useTown((s) => s.bank)!;
  return (
    <Section title="Balance">
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
    </Section>
  );
}

/** The pressure gauge: is the accounting healthy (price drift) and are agents dying for lack of tokens (deaths, the cap). */
function Health() {
  const bank = useTown((s) => s.bank);
  if (!bank) return <Loading />;
  const drift = bank.drift && bank.drift.models.length ? bank.drift : null;
  if (!drift && !(bank.deaths && bank.cap)) return <Empty>No drift or out-of-tokens figures yet.</Empty>;
  return (<>
    {drift ? (
      <Section title={`Drift (${drift.day}, 24 h)`}>
        <p className="muted">Adjusted output tokens × output list price vs what the SDK says the sessions cost. Target 0.90–1.10.</p>
        <table className="table">
          <tbody>
            {drift.models.map((r) => (
              <tr key={r.model ?? ""} title={`$${r.adjustedUsd.toFixed(2)} adjusted vs $${r.costUsd.toFixed(2)} SDK · ${r.sessions} session${r.sessions === 1 ? "" : "s"}${r.backfilled ? ` · ${r.backfilled} back-filled left out` : ""}`}>
                <td>{r.model}</td>
                <td style={r.ratio !== null && Math.abs(r.ratio - 1) > 0.1 ? { color: "#c0392b" } : undefined}>drift: {r.ratio === null ? "n/a" : r.ratio.toFixed(2)} (24 h)</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    ) : null}
    {bank.deaths && bank.cap ? (
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
  </>);
}
