/**
 * The planning desk's step sizes (docs/legible-delegation.md §7.3-7.4, UI / UX E): the collective's S / M / L table and
 * the oversell setting and the two exploration defaults (tokens a desk buys per day, an explorer's chunk; gr_bre43gflz9), editable by an admin and saved through PUT /api/town/defaults, with what steps really cost
 * beside them (GET /api/town/pricing `stepCalibration`, an admin's). The Planner proposes changes as policy asks; a human decides.
 */
import { clearDraft, useDraft } from "../draft";
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
  // keyed by the saved table: unsaved edits survive the panel closing, and a table changed elsewhere starts the fields over (src/draft.ts)
  const dk = `pricing:${cur.stepSizes.S}|${cur.stepSizes.M}|${cur.stepSizes.L}|${cur.oversell}|${cur.exploreTokensPerDeskPerDay}|${cur.exploreChunkTokens}:`;
  const [sizes, setSizes] = useDraft<Record<StepSize, string>>(`${dk}sizes`, { S: kOf(cur.stepSizes.S), M: kOf(cur.stepSizes.M), L: kOf(cur.stepSizes.L) });
  const [oversell, setOversell] = useDraft(`${dk}oversell`, String(Math.round(cur.oversell * 100)));
  // exploration (gr_bre43gflz9): what a desk buys per day, in tokens, and the chunk one explorer reserves, in thousands
  const [perDesk, setPerDesk] = useDraft(`${dk}perDesk`, String(cur.exploreTokensPerDeskPerDay));
  const [chunk, setChunk] = useDraft(`${dk}chunk`, kOf(cur.exploreChunkTokens));
  const perDeskN = Number(perDesk), chunkN = Math.round(Number(chunk) * 1000);
  const exploreOk = Number.isInteger(perDeskN) && perDeskN >= 0 && Number.isFinite(chunkN) && chunkN >= 10_000 && chunkN <= 2_000_000;
  const table = Object.fromEntries(SIZES.map((z) => [z, Math.round(Number(sizes[z]) * 1000)])) as Record<StepSize, number>;
  const pct = Number(oversell);
  const ok = SIZES.every((z) => Number.isFinite(table[z]) && table[z] > 0) && table.S < table.M && table.M < table.L && Number.isFinite(pct) && pct >= 0 && pct <= 100;
  const save = async () => {
    const r = await api().setGrantPricing({ stepSizes: table, oversell: pct / 100 });
    clearDraft(dk);
    if (town) store.set({ town: { ...town, ...r } });
    store.toast(`Saved: S ${fmtTokens(r.stepSizes.S)}, M ${fmtTokens(r.stepSizes.M)}, L ${fmtTokens(r.stepSizes.L)}, oversell ${Math.round(r.oversell * 100)}%.`, "ok");
  };
  const saveExplore = async () => {
    const r = await api().setGrantPricing({ exploreTokensPerDeskPerDay: perDeskN, exploreChunkTokens: chunkN });
    clearDraft(dk);
    if (town) store.set({ town: { ...town, ...r } });
    store.toast(`Saved: ${fmtTokens(r.exploreTokensPerDeskPerDay)} exploration tokens per desk per day, ${fmtTokens(r.exploreChunkTokens)} per explorer.`, "ok");
  };
  return (
    <>
      <p className="direction">A grant's ask is the sum of its steps' sizes from this table. The Planner proposes changes to it as policy asks in the decision queue. A human decides them.</p>
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
      <Section title="Exploration">
        <p className="direction">A goal's daily exploration cap is its desks times the tokens per desk. Each explorer reserves one chunk.</p>
        <form className="form" onSubmit={(e) => e.preventDefault()}>
          <div className="pricing-table">
            <Field label="Tokens per desk per day" hint="A goal with 5 desks may explore 5 times this each day.">
              <input inputMode="numeric" aria-label="Exploration tokens per desk per day" value={perDesk} disabled={!admin} onChange={(e) => setPerDesk(e.target.value)} />
            </Field>
            <Field label="Chunk per explorer (thousand tokens)">
              <input inputMode="numeric" aria-label="Explorer chunk" value={chunk} disabled={!admin} onChange={(e) => setChunk(e.target.value)} />
            </Field>
          </div>
          {admin ? <div className="actions"><Act tone="primary" disabled={!exploreOk} run={saveExplore} title={exploreOk ? "Save the two exploration defaults for this collective" : "Tokens per desk is a whole number from 0; the chunk is 10 to 2,000 thousand"}>Save</Act></div> : null}
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
