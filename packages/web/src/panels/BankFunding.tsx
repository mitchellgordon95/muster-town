/**
 * Bank sections (panel kind `bank`): the top contributors, donating (a Bank input or a gift to one
 * building), the inputs that fund the town, and each building's share. Donating moved here from the
 * Town Hall donation box.
 */
import { useState } from "react";
import type { AllocationAuth, BankRecurrence } from "@muster-town/schema";
import { api, type Bank } from "../api";
import { store, useTown } from "../state";
import { SignInNote } from "../auth/auth";
import { Act, Empty, Field, Loading, Pill, Section, fmtTokens, timeAgo, useLoad } from "./ui";

interface Props { bank: Bank; onChange: () => void }

const MEDALS = ["🥇", "🥈", "🥉"];
const PER: Record<BankRecurrence, string> = { once: "once", daily: "day", weekly: "week", monthly: "month" };

/** Top contributors by tokens put in: Bank credits plus direct donations. */
export function BankContributors({ bank }: { bank: Bank }) {
  const top = bank.contributors;
  const max = top[0]?.tokens ?? 1;
  return (
    <Section title="Top contributors">
      {!top.length ? <Empty>No one has put tokens in yet. Be the first.</Empty> : (
        <ol className="leaderboard">
          {top.map((c, i) => (
            <li key={c.userId} className={i < 3 ? `lb-row lb-top lb-${i + 1}` : "lb-row"}>
              <span className="lb-rank">{MEDALS[i] ?? i + 1}</span>
              <span className="lb-name">{c.name}</span>
              <span className="lb-bar"><i style={{ width: `${Math.max(2, (c.tokens / max) * 100)}%` }} /></span>
              <span className="lb-tokens" title={`${fmtTokens(c.bankTokens)} through the Bank · ${fmtTokens(c.donatedTokens)} to buildings directly`}>{fmtTokens(c.tokens)}</span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

/**
 * Donate an API key into the Bank (once or recurring, shared by every building's %). The owner can also add
 * their subscription (daily, expires each day). Funding one building directly is in BuildingFunding.
 */
export function BankDonate({ onChange }: Props) {
  const me = useTown((s) => s.me);
  const [source, setSource] = useState<"api-key" | "subscription">("api-key");
  const [tokens, setTokens] = useState(1_000_000);
  const [recurrence, setRecurrence] = useState<BankRecurrence>("once");
  const [weeklyCap, setWeeklyCap] = useState(10_000_000);
  const [model, setModel] = useState("claude-opus-5-5");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  if (!me) return <Section title="Donate to the Bank"><SignInNote to="donate" /></Section>;
  const sub = source === "subscription";
  const ready = tokens >= 1 && (sub || !!apiKey.trim());
  const submit = async () => {
    await api().addBankInput({
      label: label.trim() || (sub ? `${me.user.name}'s subscription` : `${me.user.name}'s API key`),
      source, model, tokens, recurrence: sub ? "daily" : recurrence,
      weeklyCapTokens: sub ? weeklyCap : undefined, apiKey: sub ? undefined : apiKey.trim(),
    });
    store.toast(`Added ${fmtTokens(tokens)} tokens${sub || recurrence !== "once" ? ` ${sub ? "daily" : recurrence}` : ""} to the Bank`, "ok");
    setApiKey("");
    onChange();
  };
  return (
    <Section title="Donate to the Bank">
      <form className="form" onSubmit={(e) => e.preventDefault()}>
        {me.isAdmin ? (
          <Field label="Source">
            <select value={source} onChange={(e) => setSource(e.target.value as "api-key" | "subscription")}>
              <option value="api-key">API key</option>
              <option value="subscription">My subscription (owner)</option>
            </select>
          </Field>
        ) : null}
        <div className="row2">
          <Field label={sub ? "Tokens per day" : "Tokens"}><input type="number" min={1} step={100000} value={tokens} onChange={(e) => setTokens(+e.target.value)} /></Field>
          {sub
            ? <Field label="Weekly cap"><input type="number" min={1} step={1000000} value={weeklyCap} onChange={(e) => setWeeklyCap(+e.target.value)} /></Field>
            : <Field label="How often">
                <select value={recurrence} onChange={(e) => setRecurrence(e.target.value as BankRecurrence)}>
                  <option value="once">Once</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
                </select>
              </Field>}
        </div>
        <div className="row2">
          <Field label="Label (optional)"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={sub ? "Max plan" : "My key"} /></Field>
          <Field label="Model"><input value={model} onChange={(e) => setModel(e.target.value)} /></Field>
        </div>
        {sub ? <div className="foot-note">Subscription tokens expire at each daily renewal; buildings spend them first.</div> : (
          <Field label="Anthropic API key" hint="Stored server-side, never shown again.">
            <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-ant-…" />
          </Field>
        )}
        <div className="actions"><Act tone="primary" disabled={!ready} run={submit}>Donate</Act></div>
      </form>
    </Section>
  );
}

/** Blended $ per 1M tokens for the estimate next to an amount (VITE_USD_PER_MTOK, else $1; each viewer can change it). */
const DEFAULT_USD_PER_MTOK = Number(import.meta.env.VITE_USD_PER_MTOK) > 0 ? Number(import.meta.env.VITE_USD_PER_MTOK) : 1;
const RATE_KEY = "muster-town.usdPerMTok";
function loadRate(): number {
  try { const v = Number(localStorage.getItem(RATE_KEY)); return v > 0 ? v : DEFAULT_USD_PER_MTOK; } catch { return DEFAULT_USD_PER_MTOK; }
}
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n < 10 ? 2 : 0 });

const AUTH_LABEL: Record<AllocationAuth, string> = { subscription: "Subscription", "api-key": "API key", "donor-key": "Donor's key" };
const AUTH_TONE: Record<AllocationAuth, string> = { subscription: "ok", "api-key": "warn", "donor-key": "" };
const AUTH_HINT: Record<AllocationAuth, string> = {
  subscription: "Runs on the owner's Claude subscription. Drawn first; a session that hits the plan's spend limit reruns once on the API key.",
  "api-key": "Paid per use with the town's ANTHROPIC_API_KEY. The buffer sessions fall back to when the subscription is out.",
  "donor-key": "Runs on the donor's own Anthropic API key.",
};

/**
 * One building's funding: its allocations (how each is paid for, allocated / spent / left; an admin can retire one)
 * and a form to add one: tokens (with a $ estimate), Subscription or API key, and a label.
 */
export function BuildingFunding({ onChange }: { onChange: () => void }) {
  const me = useTown((s) => s.me);
  const buildings = useTown((s) => s.buildings).filter((b) => b.kind !== "town-hall");
  const [buildingId, setBuildingId] = useState(buildings[0]?.id ?? "");
  const [showRetired, setShowRetired] = useState(false);
  const rows = useLoad(() => (buildingId ? api().allocations(buildingId) : Promise.resolve([])), [buildingId]);
  const admin = !!me?.isAdmin;
  const [picked, setAuth] = useState<AllocationAuth>("subscription");
  // only admins fund with the town's own credentials; everyone else gives their own key
  const auth: AllocationAuth = admin ? picked : "donor-key";
  const [tokens, setTokens] = useState(10_000_000);
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [rate, setRate] = useState(loadRate);
  const b = buildings.find((x) => x.id === buildingId);
  const all = rows.data ?? [];
  const live = all.filter((a) => !a.retired);
  const retired = all.filter((a) => a.retired);
  const shown = showRetired ? all : live;
  const changed = () => { rows.reload(); onChange(); };
  const saveRate = (v: number) => { setRate(v); try { if (v > 0) localStorage.setItem(RATE_KEY, String(v)); } catch { /* private window */ } };
  const ready = tokens >= 1 && !!buildingId && (auth !== "donor-key" || !!apiKey.trim() || !!me?.user.hasApiKey);
  const submit = async () => {
    const fallback = auth === "subscription" ? `${me!.user.name}'s Claude subscription` : auth === "api-key" ? "API-key buffer" : `${me!.user.name}'s API key`;
    await api().donate({ tokens, buildingId, auth, label: label.trim() || fallback, apiKey: auth === "donor-key" ? apiKey.trim() || undefined : undefined });
    store.toast(`Added ${fmtTokens(tokens)} tokens (${AUTH_LABEL[auth]}) to ${b?.name ?? buildingId}`, "ok");
    setApiKey(""); setLabel("");
    changed();
  };
  const left = live.reduce((s, a) => s + a.remainingTokens, 0);
  return (
    <Section title="Building funding" right={
      <select className="funding-building" value={buildingId} onChange={(e) => setBuildingId(e.target.value)} aria-label="Building">
        {buildings.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
    }>
      {rows.loading && !rows.data ? <Loading /> : !shown.length ? <Empty>{b?.name ?? "This building"} has no funding yet.</Empty> : (
        <table className="table funding-table">
          <thead><tr><th>Allocation</th><th>Allocated</th><th>Spent</th><th>Left</th>{admin ? <th /> : null}</tr></thead>
          <tbody>
            {shown.map((a) => (
              <tr key={a.id} className={a.retired ? "muted" : undefined}>
                <td>
                  <div className="funding-label">{a.label || <span className="muted">(unlabelled)</span>}</div>
                  <Pill tone={a.retired ? "" : AUTH_TONE[a.auth]} title={AUTH_HINT[a.auth]}>{AUTH_LABEL[a.auth]}</Pill>{" "}
                  {a.retired ? <Pill>retired</Pill> : null} <span className="muted">{a.userName} · {timeAgo(a.createdAt)}</span>
                </td>
                <td>{fmtTokens(a.tokens)}</td>
                <td title={a.spentUsd ? usd(a.spentUsd) : undefined}>{fmtTokens(a.spentTokens)}</td>
                <td>{a.retired ? "–" : fmtTokens(a.remainingTokens)}</td>
                {admin ? (
                  <td className="actions">{a.retired ? null : (
                    <Act small tone="bad" title="Stop drawing from it; its spend history stays" run={async () => {
                      if (!confirm(`Retire "${a.label || a.id}"? ${fmtTokens(a.remainingTokens)} unspent tokens leave ${b?.name ?? "the building"}'s budget.`)) return;
                      await api().retireAllocation(a.id);
                      store.toast(`Retired ${a.label || a.id}`, "ok");
                      changed();
                    }}>Retire</Act>
                  )}</td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="funding-summary">
        <span>{fmtTokens(left)} left</span>
        {retired.length ? <button type="button" className="btn sm link" onClick={() => setShowRetired(!showRetired)}>{showRetired ? "Hide" : "Show"} {retired.length} retired</button> : null}
      </div>
      {!me ? <SignInNote to="fund a building" /> : (
        <form className="form funding-form" onSubmit={(e) => e.preventDefault()}>
          <div className="row2">
            <Field label="Tokens" hint={`≈ ${usd((tokens / 1_000_000) * rate)} at ${usd(rate)} per 1M tokens (estimate)`}>
              <input type="number" min={1} step={1_000_000} value={tokens} onChange={(e) => setTokens(+e.target.value)} />
            </Field>
            <Field label="Paid by">
              <select value={auth} onChange={(e) => setAuth(e.target.value as AllocationAuth)}>
                {admin ? <option value="subscription">Subscription (monthly allowance)</option> : null}
                {admin ? <option value="api-key">API key (one-time buffer)</option> : null}
                <option value="donor-key">My own API key</option>
              </select>
            </Field>
          </div>
          <div className="row2">
            <Field label="Label"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={auth === "subscription" ? "Mitchell's Claude subscription, October" : auth === "api-key" ? "API-key buffer" : "My key"} /></Field>
            <Field label="Blended rate ($ per 1M tokens)"><input type="number" min={0.01} step={0.25} value={rate} onChange={(e) => saveRate(+e.target.value)} /></Field>
          </div>
          {auth === "donor-key" ? (
            <Field label={me.user.hasApiKey ? "Anthropic API key (optional: you have one stored)" : "Anthropic API key"} hint="Stored server-side, never shown again.">
              <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-ant-…" />
            </Field>
          ) : null}
          <div className="foot-note">{AUTH_HINT[auth]}</div>
          <div className="actions"><Act tone="primary" disabled={!ready} run={submit}>Add funding</Act></div>
        </form>
      )}
    </Section>
  );
}

/** What funds the town. The owner of an input, or an admin, can cancel it (past credits stay in the Bank). */
export function BankInputs({ bank, onChange }: Props) {
  const me = useTown((s) => s.me);
  const inputs = [...bank.inputs].sort((a, b) => Number(!!a.cancelledAt) - Number(!!b.cancelledAt) || b.createdAt.localeCompare(a.createdAt));
  return (
    <Section title="Funding" right={bank.dailyInflowTokens ? <Pill tone="ok">+{fmtTokens(bank.dailyInflowTokens)}/day</Pill> : null}>
      {!inputs.length ? <Empty>No inputs yet.</Empty> : (
        <table className="table">
          <thead><tr><th>Input</th><th>From</th><th>Tokens</th><th>Credited</th><th /></tr></thead>
          <tbody>
            {inputs.map((i) => (
              <tr key={i.id} className={i.cancelledAt ? "muted" : undefined}>
                <td>{i.label} {i.source === "subscription" ? <Pill tone="warn">expires daily</Pill> : null}</td>
                <td>{i.userName}</td>
                <td>{fmtTokens(i.tokens)} {i.recurrence === "once" ? "once" : `/ ${PER[i.recurrence]}`}</td>
                <td>{fmtTokens(i.creditedTokens)}{i.cancelledAt ? <> · cancelled {timeAgo(i.cancelledAt)}</> : null}</td>
                <td>{!i.cancelledAt && me && (me.isAdmin || me.user.id === i.userId)
                  ? <Act small tone="bad" run={async () => { await api().cancelBankInput(i.id); store.toast(`Cancelled ${i.label}`, "ok"); onChange(); }}>Cancel</Act>
                  : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

/** Each building's % of the Bank and what it can still draw. An admin can set or clear a share. */
export function BankShares({ bank, onChange }: Props) {
  const isAdmin = useTown((s) => !!s.me?.isAdmin);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const rows = [...bank.buildings].sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
  const save = async (buildingId: string, pct: number | null) => {
    await api().setBankShare(buildingId, pct);
    setEdit(({ [buildingId]: _, ...rest }) => rest);
    onChange();
  };
  return (
    <Section title="Shares">
      <table className="table">
        <thead><tr><th>Building</th><th>Share</th><th>Can draw</th><th title="Unspent tokens donated straight to this building">Held</th>{isAdmin ? <th /> : null}</tr></thead>
        <tbody>
          {rows.map((r) => {
            const draft = edit[r.buildingId];
            return (
              <tr key={r.buildingId}>
                <td>{r.name}</td>
                <td>
                  {draft !== undefined
                    ? <input className="pct-input" type="number" min={0} max={100} step={1} value={draft} autoFocus onChange={(e) => setEdit({ ...edit, [r.buildingId]: e.target.value })} />
                    : <>{r.pct}% {r.explicit ? null : <span className="muted" title="No explicit share: splits what's left equally with the other labs">(auto)</span>}</>}
                </td>
                <td title={`${fmtTokens(r.expiringTokens)} expiring today · ${fmtTokens(r.durableTokens)} permanent`}>{fmtTokens(r.expiringTokens + Math.max(0, r.durableTokens))}</td>
                <td title={r.heldByAuth ? `${fmtTokens(r.heldByAuth.subscription)} subscription · ${fmtTokens(r.heldByAuth.apiKey)} API key · ${fmtTokens(r.heldByAuth.donorKey)} donors' keys` : undefined}>{fmtTokens(r.heldTokens)}</td>
                {isAdmin ? (
                  <td className="actions">
                    {draft !== undefined ? <>
                      <Act small tone="primary" disabled={draft === "" || +draft < 0 || +draft > 100} run={() => save(r.buildingId, +draft)}>Save</Act>
                      <button type="button" className="btn sm" onClick={() => setEdit(({ [r.buildingId]: _, ...rest }) => rest)}>Cancel</button>
                    </> : <>
                      <button type="button" className="btn sm" onClick={() => setEdit({ ...edit, [r.buildingId]: String(r.pct) })}>Set</button>
                      {r.explicit ? <Act small run={() => save(r.buildingId, null)} title="Back to an equal split of what's left">Auto</Act> : null}
                    </>}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="foot-note">Labs without a set share split what's left equally. Set shares can add up to 100% at most.</div>
    </Section>
  );
}
