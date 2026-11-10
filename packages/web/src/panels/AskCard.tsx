/**
 * The ask card (docs/legible-delegation.md §5, UI / UX B): one component for every ask in the decision queue. Its
 * title, the delta line (the body's first paragraph), the body, the branches as the buttons (each does the real action
 * by the ask's target, asks.ts `branchCall`; the server's hooks then retire the ask), the recommendation, the claims
 * with their check, the sources by name, a lint-failed badge, and the record one click down. A grant's card adds its
 * step strip. Names, not ids: an id only sits in a tooltip.
 */
import { useState, type ReactNode } from "react";
import type { GrantView, ScheduleView } from "@muster-town/schema";
import { api, type AskView } from "../api";
import { store, useTown } from "../state";
import { fromMillions, toMillions } from "../format";
import { Markdown } from "./Markdown";
import { StepStrip } from "./StepStrip";
import { branchCall, claimMark, deltaOf, retainerCounter, type BranchCall } from "./asks";
import { ADJ, Act, Field, MTokensInput, Pill, fmtTokens, timeAgo } from "./ui";

const TYPE_WORD: Record<AskView["type"], string> = { money: "money", click: "click", credential: "credential", meeting: "meeting", policy: "policy" };

/** The building's name (the Town when none). */
function useBuildingName(id: string | null | undefined): string {
  return useTown((s) => s.buildings.find((b) => b.id === id)?.name ?? (id ? id : "Town"));
}

/** Toast line for a decided branch. */
function doneLine(c: BranchCall, label: string): string {
  switch (c.kind) {
    case "grant": return c.action === "fund" ? "Funded." : c.action === "counter" ? "Countered: back to the manager." : c.action === "reject" ? "Proposal rejected." : c.action === "adjust" ? "Ceiling raised: the grant runs on." : "Grant cut.";
    case "retainer": return c.action === "approve" ? "Retainer approved." : c.action === "counter" ? "Countered: the manager edits the schedule." : "Retainer rejected.";
    case "captain": return c.action === "accept" ? "Captain accepted." : "Captain ask declined.";
    case "access": return c.grant ? "Let in." : "Declined.";
    case "request": return c.action === "claim" ? "Claimed: it is yours to do." : "Request declined.";
    default: return `Decided: ${label}.`;
  }
}

/**
 * The branches as buttons, wired to the real action. Adjust opens a tokens field (the new ceiling); Counter on a
 * proposal opens the note and tokens form; Counter on a retainer opens the same shape: tokens per run, an optional end
 * date, a note. `grant` is the ask's target grant, when the in-tray carries it (the fund amount, the ceiling to adjust
 * from); `retainer` its target schedule (the asked per-run amount the field starts from).
 */
export function AskButtons({ ask, grant, retainer, onDecided, deckSlide }: { ask: AskView; grant?: GrantView; retainer?: Pick<ScheduleView, "tokensPerRun" | "endsAt">; onDecided: () => void; deckSlide?: number }) {
  const [form, setForm] = useState<{ label: string; call: BranchCall } | null>(null);
  const ceiling = grant ? (grant.grantTokens ?? grant.askTokens) + (grant.forecast?.shortfall ?? 0) : 0;
  const [tokens, setTokens] = useState(grant ? toMillions(form?.call.kind === "grant" && form.call.action === "counter" ? grant.askTokens : ceiling) : "");
  const [note, setNote] = useState("");
  const [noting, setNoting] = useState(false);
  const [perRun, setPerRun] = useState(retainer ? toMillions(retainer.tokensPerRun) : "");
  const [until, setUntil] = useState("");
  const counter = retainerCounter(perRun, until, note, retainer?.tokensPerRun);
  const n = fromMillions(tokens);
  const tokensOk = Number.isFinite(n) && n > 0;
  const id = ask.targetId ?? "";
  const run = (c: BranchCall, label: string) => async () => {
    const slide = deckSlide ? { deckSlide } : {};
    switch (c.kind) {
      case "grant":
        if (c.action === "fund") await api().decideGrant(id, { action: "fund", note, ...(grant ? { tokens: grant.askTokens } : {}), ...slide });
        else if (c.action === "counter") await api().decideGrant(id, { action: "counter", note, ...(tokensOk && n !== grant?.askTokens ? { tokens: n } : {}), ...slide });
        else if (c.action === "adjust") await api().decideGrant(id, { action: "adjust", note, tokens: n, ...slide });
        else await api().decideGrant(id, { action: c.action, note, ...slide });
        break;
      case "retainer": await api().decideRetainer(id, { action: c.action, note, ...(c.action === "counter" ? counter ?? {} : {}), ...slide }); break;
      case "captain": await api().decideCaptain(id, c.action, note || undefined); break;
      case "access": await api().decideAccess(id, c.grant); break;
      case "request": await api().request(id, c.action, note.trim() || undefined); break;
      case "ask": await api().decideAsk(ask.id, c.decision, note); break;
      case "none": return;
    }
    store.toast(c.kind === "ask" && note.trim() ? `Decided: ${label}, with your note.` : c.kind === "request" && c.action === "claim" && note.trim() ? "Claimed, with your note: the author hears it." : doneLine(c, label), "ok");
    setForm(null);
    onDecided();
  };
  const branches = ask.branches.map((b) => ({ b, c: branchCall(ask, b, grant) })).filter((x) => x.c.kind !== "none");
  if (!branches.length) return null;
  const tone = (i: number, c: BranchCall) => (c.kind === "grant" && (c.action === "reject" || c.action === "cut")) || (c.kind === "retainer" && c.action === "reject") ? "bad" : i === 0 ? "primary" : undefined;
  const needsForm = (c: BranchCall) => "form" in c && !!c.form;
  // a click ask's plain branches (Done, Decline, …) take the human's optional words, sent as the decision's
  const plain = branches.some(({ c }) => c.kind === "ask");
  // a form whose note may stay empty: a grant's adjust (tokens decide it) and a request's claim
  const noteOptional = (c: BranchCall) => (c.kind === "grant" && c.action === "adjust") || (c.kind === "request" && c.action === "claim");
  return (
    <div className="ask-decide">
      {plain && noting ? (
        <Field label="Note"><textarea className="ask-note" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional: what you did instead, or why" aria-label="Note" autoFocus /></Field>
      ) : null}
      <div className="actions ask-branches">
        {branches.map(({ b, c }, i) => needsForm(c)
          ? <button key={b.label} className={`btn sm${form?.label === b.label ? " on" : ""}`} onClick={() => { setForm(form?.label === b.label ? null : { label: b.label, call: c }); if (grant) setTokens(toMillions(c.kind === "grant" && c.action === "counter" ? grant.askTokens : ceiling)); if (retainer) setPerRun(toMillions(retainer.tokensPerRun)); }}>{b.label}…</button>
          : <Act key={b.label} small tone={tone(i, c)} run={run(c, b.label)}>{b.label}</Act>)}
        {plain && !noting && !form ? <button className="link ask-note-toggle" onClick={() => setNoting(true)}>Add a note</button> : null}
      </div>
      {form ? (
        <div className="ask-form">
          {form.call.kind === "grant" ? (
            <Field label={form.call.action === "adjust" ? "New ceiling" : "Tokens"}><MTokensInput value={tokens} onChange={setTokens} ariaLabel={form.call.action === "adjust" ? "New ceiling" : "Tokens"} /></Field>
          ) : null}
          {form.call.kind === "retainer" ? (
            <div className="ask-form-row">
              <Field label="Tokens per run"><MTokensInput value={perRun} onChange={setPerRun} ariaLabel="Tokens per run" /></Field>
              <Field label="Ends"><input type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="End date" title={retainer?.endsAt ? `Asked: ends ${retainer.endsAt.slice(0, 10)}` : "optional: a new last day"} /></Field>
            </div>
          ) : null}
          <Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder={form.call.kind === "request" ? (form.call.action === "claim" ? "optional: how you'll do it, e.g. use Wright's VPS" : "required: why you decline it") : noteOptional(form.call) || form.call.kind === "retainer" ? "optional" : "required: what to change"} aria-label="Note" /></Field>
          {form.call.kind === "retainer" ? <div className="muted">Change the per-run amount, the end date or both, or just say what to change. The manager edits the schedule, which asks again.</div> : null}
          {form.call.kind === "grant" && form.call.action === "adjust" && grant ? <div className="muted">It has spent {fmtTokens(grant.spentTokens)} {ADJ}. The new ceiling must be more.</div> : null}
          <div className="actions">
            <Act small tone="primary" disabled={form.call.kind === "grant" && form.call.action === "adjust" ? !tokensOk || (grant ? n <= grant.spentTokens : false) : form.call.kind === "retainer" ? !counter : noteOptional(form.call) ? false : !note.trim()} run={run(form.call, form.label)}>{form.label}</Act>
            <button className="btn sm" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** One source of an ask: the building's name, its own line, when; the click opens that record. */
function SourceLine({ s, onOpenRecord }: { s: AskView["sources"][number]; onOpenRecord?: (id: string) => void }) {
  const name = useBuildingName(s.buildingId);
  return (
    <li>
      <b>{name}</b>: {s.line} <span className="muted">· {timeAgo(s.at)}</span>
      {onOpenRecord ? <> <button className="link" title={s.docId} onClick={() => onOpenRecord(s.docId)}>read it →</button></> : null}
    </li>
  );
}

export function AskCard({ ask, grant, retainer, canDecide, onDecided, onOpenRecord, aside, deckSlide }: {
  ask: AskView; grant?: GrantView; retainer?: Pick<ScheduleView, "tokensPerRun" | "endsAt">; canDecide?: boolean; onDecided: () => void; onOpenRecord?: (id: string) => void;
  /** beside the buttons: the funding view's fund / hold toggle */
  aside?: ReactNode; deckSlide?: number;
}) {
  const building = useBuildingName(ask.buildingId);
  const signedIn = useTown((s) => !!s.me);
  const { delta, rest } = deltaOf(ask.body);
  const lint = ask.tags.includes("lint-failed");
  return (
    <article className={`ask-card ask-${ask.type}${ask.status === "deferred" ? " deferred" : ""}`} aria-label={ask.title}>
      <header className="ask-head">
        <span className="ask-building">{building}</span>
        <Pill tone={ask.type === "money" ? "warn" : ""}>{TYPE_WORD[ask.type]}</Pill>
        {typeof ask.rank === "number" ? <Pill title="The Secretary's rank">#{ask.rank}</Pill> : null}
        {lint ? <Pill tone="bad" title="Filed without passing its contract or the linter: the failing rules are in its history">lint-failed</Pill> : null}
        <span className="muted">{timeAgo(ask.createdAt)}</span>
      </header>
      <h4 className="ask-title" title={ask.targetId ?? undefined}>{ask.title}</h4>
      {ask.status === "deferred" ? <div className="ask-stamp">Deferred until {ask.deferredUntil ?? "an event"}</div> : null}
      {delta ? <Markdown text={delta} className="ask-delta" /> : null}
      {rest ? <Markdown text={rest} className="ask-body" /> : null}
      {grant ? <StepStrip grant={grant} /> : null}
      {ask.recommendation ? <div className="ask-rec"><span className="ask-label">Recommends</span> {ask.recommendation}</div> : null}
      {ask.claims.length ? (
        <ul className="ask-claims">
          {ask.claims.map((c, i) => { const m = claimMark(c); return <li key={i} className={`ask-claim ${m.tone}`} title={c.check.ref ? `${c.check.kind}: ${c.check.ref}` : c.check.kind}><span className="ask-mark">{m.mark}</span> {c.text} <span className="muted">· {m.line}{c.result?.note ? ` · ${c.result.note}` : ""}</span></li>; })}
        </ul>
      ) : null}
      {signedIn && canDecide !== false
        ? <div className="ask-actions"><AskButtons ask={ask} grant={grant} retainer={retainer} onDecided={onDecided} deckSlide={deckSlide} />{aside}</div>
        : <div className="ask-actions">{aside}<span className="muted">{signedIn ? "A captain or admin decides this." : "Sign in to decide."}</span></div>}
      {ask.sources.length ? (
        <details className="ask-sources">
          <summary>Asked in {ask.sources.length} place{ask.sources.length === 1 ? "" : "s"}</summary>
          <ul>{ask.sources.map((s, i) => <SourceLine key={`${s.docId}-${i}`} s={s} onOpenRecord={onOpenRecord} />)}</ul>
        </details>
      ) : null}
      {ask.sourceDocId && onOpenRecord ? <button className="link ask-record" title={ask.sourceDocId} onClick={() => onOpenRecord(ask.sourceDocId!)}>The full record →</button> : null}
    </article>
  );
}
