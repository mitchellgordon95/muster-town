/**
 * The planning desk's step sizes (docs/legible-delegation.md §7.3-7.4, UI / UX E): the collective's S / M / L table and
 * the oversell setting, editable by an admin and saved through PUT /api/town/defaults, with what steps really cost
 * beside them (GET /api/town/pricing `stepCalibration`, an admin's). The Planner proposes changes as policy asks; a human decides.
 */
import { useEffect, useState } from "react";
import { grantPricingOf, type StepSize } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { Act, ErrorLine, Field, Section, fmtTokens, useLoad } from "./ui";

const SIZES: StepSize[] = ["S", "M", "L"];
const kOf = (n: number) => String(Math.round(n / 1000));

export function PricingTab() {
  const town = useTown((s) => s.town);
  const admin = useTown((s) => !!s.me?.isAdmin);
  // GET /api/town/pricing is an admin's: everyone else sees the table without the calibration lines
  const cal = useLoad(() => (admin ? api().pricing().then((p) => p.stepCalibration ?? null) : Promise.resolve(null)), [admin]);
  const cur = grantPricingOf(town ?? {});
  const [sizes, setSizes] = useState<Record<StepSize, string>>({ S: kOf(cur.stepSizes.S), M: kOf(cur.stepSizes.M), L: kOf(cur.stepSizes.L) });
  const [oversell, setOversell] = useState(String(Math.round(cur.oversell * 100)));
  // the snapshot arrived (or changed elsewhere): the fields follow it
  useEffect(() => { setSizes({ S: kOf(cur.stepSizes.S), M: kOf(cur.stepSizes.M), L: kOf(cur.stepSizes.L) }); setOversell(String(Math.round(cur.oversell * 100))); }, [cur.stepSizes.S, cur.stepSizes.M, cur.stepSizes.L, cur.oversell]);
  const table = Object.fromEntries(SIZES.map((z) => [z, Math.round(Number(sizes[z]) * 1000)])) as Record<StepSize, number>;
  const pct = Number(oversell);
  const ok = SIZES.every((z) => Number.isFinite(table[z]) && table[z] > 0) && table.S < table.M && table.M < table.L && Number.isFinite(pct) && pct >= 0 && pct <= 100;
  const save = async () => {
    const r = await api().setGrantPricing({ stepSizes: table, oversell: pct / 100 });
    if (town) store.set({ town: { ...town, ...r } });
    store.toast(`Saved: S ${fmtTokens(r.stepSizes.S)}, M ${fmtTokens(r.stepSizes.M)}, L ${fmtTokens(r.stepSizes.L)}, oversell ${Math.round(r.oversell * 100)}%.`, "ok");
  };
  return (
    <>
      <p className="direction">A grant's ask is the sum of its steps' sizes from this table. The Planner proposes changes to it as policy asks in the Town Hall in-tray. A human decides them.</p>
      <Section title="Step sizes">
        <form className="form" onSubmit={(e) => e.preventDefault()}>
          <div className="pricing-table">
            {SIZES.map((z) => (
              <Field key={z} label={`${z} (thousand tokens)`}>
                <input inputMode="numeric" aria-label={`${z} size`} value={sizes[z]} disabled={!admin} onChange={(e) => setSizes({ ...sizes, [z]: e.target.value })} />
              </Field>
            ))}
            <Field label="Oversell (%)" hint="0: free tokens hold each funded grant's ceiling. 100: they hold its expected spend.">
              <input inputMode="numeric" aria-label="Oversell" value={oversell} disabled={!admin} onChange={(e) => setOversell(e.target.value)} />
            </Field>
          </div>
          {admin ? <div className="actions"><Act tone="primary" disabled={!ok} run={save} title={ok ? "Save the table and oversell for this collective" : "Sizes must rise S < M < L; oversell is 0 to 100"}>Save</Act></div> : <div className="muted">Only an admin changes these.</div>}
        </form>
      </Section>
      <Section title="What steps really cost">
        <ErrorLine error={cal.error} />
        {cal.data?.lines?.length ? (
          <>
            <ul className="pricing-cal">{cal.data.lines.map((l) => <li key={l}>{l}</li>)}</ul>
            <div className="muted">The last {cal.data.days} days. A size with fewer than {cal.data.minSample} steps prices at 1.0.</div>
          </>
        ) : <div className="muted">{cal.loading ? "Loading…" : "No completed steps to calibrate yet."}</div>}
      </Section>
    </>
  );
}
