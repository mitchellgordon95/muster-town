/**
 * The Bank (its teller counter, south of the road): the town's available tokens, then the funding sections
 * (contributors, donating, inputs, shares) from BankFunding.
 */
import { api } from "../api";
import { store, useTown } from "../state";
import { Glyph, PanelShell } from "./PanelShell";
import { BankContributors, BankDonate, BankInputs, BankShares, BuildingFunding } from "./BankFunding";
import { Loading, Section, fmtTokens } from "./ui";

/** Refetch the summary the sign and these sections read. */
const reload = () => { api().bank().then((bank) => store.set({ bank }), () => undefined); };

export function BankPanel() {
  const bank = useTown((s) => s.bank);
  return (
    <PanelShell icon={<Glyph kind="bank" />} title="The Bank" subtitle="Tokens available to the town">
      <Section title="Balance">
        {!bank ? <Loading /> : (
          <table className="table">
            <tbody>
              <tr><td>Town total (Bank + held by buildings)</td><td><b>{bank.townTokens.toLocaleString("en-US")}</b></td></tr>
              <tr><td>In the Bank (split by share)</td><td>{bank.balanceTokens.toLocaleString("en-US")}</td></tr>
              <tr><td>Expires today (daily allowance, no rollover)</td><td>{bank.expiringTokens.toLocaleString("en-US")}</td></tr>
              <tr><td>Permanent pool (stays until spent)</td><td>{bank.durableTokens.toLocaleString("en-US")}</td></tr>
              <tr><td>Held by buildings (donated to one building)</td><td>{bank.heldTokens.toLocaleString("en-US")}</td></tr>
              {bank.heldByAuth ? <>
                <tr className="sub-row"><td>of which subscription</td><td>{bank.heldByAuth.subscription.toLocaleString("en-US")}</td></tr>
                <tr className="sub-row"><td>of which API key</td><td>{bank.heldByAuth.apiKey.toLocaleString("en-US")}</td></tr>
                {bank.heldByAuth.donorKey ? <tr className="sub-row"><td>of which donors' own keys</td><td>{bank.heldByAuth.donorKey.toLocaleString("en-US")}</td></tr> : null}
              </> : null}
              <tr><td>Expected inflow per day</td><td>{fmtTokens(bank.dailyInflowTokens)}</td></tr>
            </tbody>
          </table>
        )}
      </Section>
      {bank && <>
        <BankContributors bank={bank} />
        <BuildingFunding onChange={reload} />
        <BankDonate bank={bank} onChange={reload} />
        <BankInputs bank={bank} onChange={reload} />
        <BankShares bank={bank} onChange={reload} />
      </>}
    </PanelShell>
  );
}
