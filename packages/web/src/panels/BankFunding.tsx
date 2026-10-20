/**
 * Bank sections (panel kind `bank`): the top contributors, donating (a Bank input or a gift to one
 * building), the inputs that fund the town, and each building's share. Donating moved here from the
 * Town Hall donation box.
 */
import { useState } from "react";
import type { BankRecurrence } from "@muster-town/schema";
import { api, type Bank } from "../api";
import { store, useTown } from "../state";
import { SignInNote } from "../auth/auth";
import { Act, Empty, Field, Pill, Section, fmtTokens, timeAgo } from "./ui";

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
 * Donate: an API key into the Bank (once or recurring, shared by every building's %), or tokens
 * straight to one building. The owner can also add their subscription (daily, expires each day).
 */
export function BankDonate({ onChange }: Props) {
  const me = useTown((s) => s.me);
  const buildings = useTown((s) => s.buildings).filter((b) => b.kind !== "town-hall");
  const [to, setTo] = useState<"bank" | "building">("bank");
  const [source, setSource] = useState<"api-key" | "subscription">("api-key");
  const [tokens, setTokens] = useState(1_000_000);
  const [recurrence, setRecurrence] = useState<BankRecurrence>("once");
  const [weeklyCap, setWeeklyCap] = useState(10_000_000);
  const [model, setModel] = useState("claude-opus-5-5");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [buildingId, setBuildingId] = useState(buildings[0]?.id ?? "");
  if (!me) return <Section title="Donate"><SignInNote to="donate" /></Section>;
  const sub = to === "bank" && source === "subscription";
  const ready = tokens >= 1 && (to === "building" ? !!buildingId : sub || !!apiKey.trim());
  const submit = async () => {
    if (to === "building") {
      await api().donate({ tokens, buildingId, apiKey: apiKey.trim() || undefined });
      store.toast(`Donated ${fmtTokens(tokens)} tokens to ${buildings.find((b) => b.id === buildingId)?.name ?? buildingId}`, "ok");
    } else {
      await api().addBankInput({
        label: label.trim() || (sub ? `${me.user.name}'s subscription` : `${me.user.name}'s API key`),
        source, model, tokens, recurrence: sub ? "daily" : recurrence,
        weeklyCapTokens: sub ? weeklyCap : undefined, apiKey: sub ? undefined : apiKey.trim(),
      });
      store.toast(`Added ${fmtTokens(tokens)} tokens${sub || recurrence !== "once" ? ` ${sub ? "daily" : recurrence}` : ""} to the Bank`, "ok");
    }
    setApiKey("");
    onChange();
  };
  return (
    <Section title="Donate">
      <form className="form" onSubmit={(e) => e.preventDefault()}>
        <div className="row2">
          <Field label="Give to">
            <select value={to} onChange={(e) => setTo(e.target.value as "bank" | "building")}>
              <option value="bank">The Bank (split by share)</option>
              <option value="building">One building</option>
            </select>
          </Field>
          {to === "building" ? (
            <Field label="Building">
              <select value={buildingId} onChange={(e) => setBuildingId(e.target.value)}>{buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            </Field>
          ) : me.isAdmin ? (
            <Field label="Source">
              <select value={source} onChange={(e) => setSource(e.target.value as "api-key" | "subscription")}>
                <option value="api-key">API key</option>
                <option value="subscription">My subscription (owner)</option>
              </select>
            </Field>
          ) : null}
        </div>
        <div className="row2">
          <Field label={sub ? "Tokens per day" : "Tokens"}><input type="number" min={1} step={100000} value={tokens} onChange={(e) => setTokens(+e.target.value)} /></Field>
          {to === "bank" ? (sub
            ? <Field label="Weekly cap"><input type="number" min={1} step={1000000} value={weeklyCap} onChange={(e) => setWeeklyCap(+e.target.value)} /></Field>
            : <Field label="How often">
                <select value={recurrence} onChange={(e) => setRecurrence(e.target.value as BankRecurrence)}>
                  <option value="once">Once</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
                </select>
              </Field>) : null}
        </div>
        {to === "bank" ? (
          <div className="row2">
            <Field label="Label (optional)"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={sub ? "Max plan" : "My key"} /></Field>
            <Field label="Model"><input value={model} onChange={(e) => setModel(e.target.value)} /></Field>
          </div>
        ) : null}
        {sub ? <div className="foot-note">Subscription tokens expire at each daily renewal; buildings spend them first.</div> : (
          <Field label={to === "bank" ? "Anthropic API key" : "Anthropic API key (optional)"} hint="Stored server-side, never shown again.">
            <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-ant-…" />
          </Field>
        )}
        <div className="actions"><Act tone="primary" disabled={!ready} run={submit}>Donate</Act></div>
      </form>
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
        <thead><tr><th>Building</th><th>Share</th><th>Can draw</th>{isAdmin ? <th /> : null}</tr></thead>
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
