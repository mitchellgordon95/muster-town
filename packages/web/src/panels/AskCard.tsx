/**
 * The ask card (docs/legible-delegation.md §5, UI / UX B): one component for every ask in the decision queue. Bottom
 * line first (gr_x7p580xe1o): its title, the one bold lead (the first paragraph, or the first sentence of a one-paragraph
 * body), the recommendation, the branches as the buttons with each "If you <branch>:" sentence under its own, then the
 * rest of the body in regular weight at a reading measure, the claims with their check, and the record one click down.
 * Each button does the real action by the ask's target (asks.ts `branchCall`; the server's hooks then retire the ask).
 * A grant's card adds its step strip. Names, not ids: an id only sits in a tooltip. Steer (Mitchell, 1:1 mt_mjxwzdhhd7) opens the goal editor
 * on the filing building's goal with a 1:1 with its manager beside it, about this ask and its job thread.
 */
import { type ReactNode } from "react";
import { clearDraft, useDraft } from "../draft";
import type { GrantView, ScheduleView } from "@muster-town/schema";
import { api, type AskView } from "../api";
import { store, useTown } from "../state";
import { fromMillions, toMillions } from "../format";
import { Markdown } from "./Markdown";
import { StepStrip } from "./StepStrip";
import { steerAsk, steerTarget } from "./oneOnOne";
import { branchCall, claimMark, deltaOf, retainerCounter, splitConsequences, type BranchCall } from "./asks";
import { ADJ, Act, Field, MTokensInput, Pill, fmtTokens, timeAgo } from "./ui";

/** What the building is asking for, after "<Building> is asking": the big line at the top of the card. */
const ASKING: Record<AskView["type"], ReactNode> = {
  money: <>for <b>tokens</b></>,
  click: <>for a <b>click</b></>,
  credential: <>for a <b>credential</b></>,
  meeting: <>for a <b>meeting</b></>,
  policy: <>for a <b>policy</b> decision</>,
  do: <>you to <b>do something</b></>,
};

/** The building as the subject of a sentence: "The Town Hall", "The town" when none, else its name. */
function subjectName(name: string): string {
  return name === "Town Hall" ? "The Town Hall" : name === "Town" ? "The town" : name;
}

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
    case "request": return c.action === "done" ? "Done: your report is in the library and the author hears it." : "Request declined.";
    case "goal": return c.action === "cut" ? "Goal proposal cut: the proposer hears it." : "Accepted: the goal tree is changed.";
    default: return `Decided: ${label}.`;
  }
}

/**
 * The branches as buttons, wired to the real action. Adjust opens a tokens field (the new ceiling); Counter on a
 * proposal opens the note and tokens form; Counter on a retainer opens the same shape: tokens per run, an optional end
 * date, a note. `grant` is the ask's target grant, when the in-tray carries it (the fund amount, the ceiling to adjust
 * from); `retainer` its target schedule (the asked per-run amount the field starts from).
 */
export function AskButtons({ ask, grant, retainer, onDecided, deckSlide, consequences }: { ask: AskView; grant?: GrantView; retainer?: Pick<ScheduleView, "tokensPerRun" | "endsAt">; onDecided: () => void; deckSlide?: number;
  /** each branch's "If you …:" sentence by label (asks.ts `splitConsequences`), drawn under its button */
  consequences?: Record<string, string> }) {
  // what the human has typed survives the card closing until they decide (drafts, src/draft.ts)
  const dk = `ask:${ask.id}:`;
  const [form, setForm] = useDraft<{ label: string; call: BranchCall } | null>(`${dk}form`, null);
  const ceiling = grant ? (grant.grantTokens ?? grant.askTokens) + (grant.forecast?.shortfall ?? 0) : 0;
  const [tokens, setTokens] = useDraft(`${dk}tokens`, () => (grant ? toMillions(form?.call.kind === "grant" && form.call.action === "counter" ? grant.askTokens : ceiling) : ""));
  const [note, setNote] = useDraft(`${dk}note`, "");
  const [noting, setNoting] = useDraft(`${dk}noting`, false);
  const [perRun, setPerRun] = useDraft(`${dk}perRun`, () => (retainer ? toMillions(retainer.tokensPerRun) : ""));
  const [until, setUntil] = useDraft(`${dk}until`, "");
  const [words, setWords] = useDraft(`${dk}words`, "");
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
      case "goal": await api().decideGoalProposal(id, { action: c.action === "cut" ? "cut" : "accept", note: note.trim(), ...(c.action === "edit" ? { text: words.trim() } : {}) }); break;
      case "ask": await api().decideAsk(ask.id, c.decision, note); break;
      case "none": return;
    }
    store.toast(c.kind === "ask" && note.trim() ? `Decided: ${label}, with your note.` : doneLine(c, label), "ok");
    setForm(null);
    clearDraft(dk);
    onDecided();
  };
  const branches = ask.branches.map((b) => ({ b, c: branchCall(ask, b, grant) })).filter((x) => x.c.kind !== "none");
  if (!branches.length) return null;
  const tone = (i: number, c: BranchCall) => (c.kind === "grant" && (c.action === "reject" || c.action === "cut")) || (c.kind === "retainer" && c.action === "reject") ? "bad" : i === 0 ? "primary" : undefined;
  const needsForm = (c: BranchCall) => "form" in c && !!c.form;
  // a click ask's plain branches (Done, Decline, …) take the human's optional words, sent as the decision's
  const plain = branches.some(({ c }) => c.kind === "ask");
  // with a consequence for any drawn branch, each button stands over its own sentence, one branch per row
  const conseq = branches.some(({ b }) => !!consequences?.[b.label]);
  // a form whose note may stay empty: a grant's adjust (tokens decide it)
  const noteOptional = (c: BranchCall) => (c.kind === "grant" && c.action === "adjust") || c.kind === "goal";
  return (
    <div className="ask-decide">
      {plain && noting ? (
        <Field label="Note"><textarea className="ask-note" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional: what you did instead, or why" aria-label="Note" autoFocus /></Field>
      ) : null}
      <div className={`actions ask-branches${conseq ? " with-conseq" : ""}`}>
        {branches.map(({ b, c }, i) => {
          const btn = needsForm(c)
            ? <button key={b.label} className={`btn sm${form?.label === b.label ? " on" : ""}`} onClick={() => { setForm(form?.label === b.label ? null : { label: b.label, call: c }); if (grant) setTokens(toMillions(c.kind === "grant" && c.action === "counter" ? grant.askTokens : ceiling)); if (retainer) setPerRun(toMillions(retainer.tokensPerRun)); }}>{b.label}…</button>
            : <Act key={b.label} small tone={tone(i, c)} run={run(c, b.label)}>{b.label}</Act>;
          return conseq ? <div key={b.label} className="ask-branch">{btn}{consequences?.[b.label] ? <Markdown text={consequences[b.label]!} className="ask-conseq" /> : null}</div> : btn;
        })}
        {plain && !noting && !form ? <button className="link ask-note-toggle" onClick={() => setNoting(true)}>Add a note</button> : null}
      </div>
      {form ? (
        <div className="ask-form">
          {form.call.kind === "grant" ? (
            <Field label={form.call.action === "adjust" ? "New ceiling" : "Tokens"}><MTokensInput value={tokens} onChange={setTokens} ariaLabel={form.call.action === "adjust" ? "New ceiling" : "Tokens"} /></Field>
          ) : null}
          {form.call.kind === "goal" && form.call.action === "edit" ? (
            <Field label="New words"><textarea className="ask-note" rows={2} maxLength={300} value={words} onChange={(e) => setWords(e.target.value)} placeholder="the goal or key result as you want it to read" aria-label="New words" autoFocus /></Field>
          ) : null}
          {form.call.kind === "retainer" ? (
            <div className="ask-form-row">
              <Field label="Tokens per run"><MTokensInput value={perRun} onChange={setPerRun} ariaLabel="Tokens per run" /></Field>
              <Field label="Ends"><input type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="End date" title={retainer?.endsAt ? `Asked: ends ${retainer.endsAt.slice(0, 10)}` : "optional: a new last day"} /></Field>
            </div>
          ) : null}
          <Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder={form.call.kind === "request" ? (form.call.action === "done" ? "required: what you did and what you saw (your report back)" : "required: why you decline it") : noteOptional(form.call) || form.call.kind === "retainer" ? "optional" : "required: what to change"} aria-label="Note" /></Field>
          {form.call.kind === "retainer" ? <div className="muted">Change the per-run amount, the end date or both, or just say what to change. The manager edits the schedule, which asks again.</div> : null}
          {form.call.kind === "grant" && form.call.action === "adjust" && grant ? <div className="muted">It has spent {fmtTokens(grant.spentTokens)} {ADJ}. The new ceiling must be more.</div> : null}
          <div className="actions">
            <Act small tone="primary" disabled={form.call.kind === "grant" && form.call.action === "adjust" ? !tokensOk || (grant ? n <= grant.spentTokens : false) : form.call.kind === "retainer" ? !counter : form.call.kind === "goal" && form.call.action === "edit" ? !words.trim() : noteOptional(form.call) ? false : !note.trim()} run={run(form.call, form.label)}>{form.label}</Act>
            <button className="btn sm" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AskCard({ ask, grant, retainer, canDecide, onDecided, onOpenRecord, aside, deckSlide }: {
  ask: AskView; grant?: GrantView; retainer?: Pick<ScheduleView, "tokensPerRun" | "endsAt">; canDecide?: boolean; onDecided: () => void; onOpenRecord?: (id: string) => void;
  /** beside the buttons: the funding view's fund / hold toggle */
  aside?: ReactNode; deckSlide?: number;
}) {
  const building = useBuildingName(ask.buildingId);
  const signedIn = useTown((s) => !!s.me);
  // a string, not the target object: useTown's selector must return a stable value
  const steer = useTown((s) => s.me && ask.buildingId && ask.status !== "decided" ? steerTarget(ask.buildingId)?.id ?? null : null);
  // the "If you <branch>:" sentences go under their buttons, signed in or not; the lead is the one bold part
  const split = splitConsequences(ask.body, ask.branches.map((b) => b.label));
  const { delta, rest } = deltaOf(split.body);
  const deciding = signedIn && canDecide !== false;
  return (
    <article className={`ask-card ask-${ask.type}${ask.status === "deferred" ? " deferred" : ""}`} aria-label={ask.title} data-branches={ask.branches.map((b) => b.label).join("|")}>
      <header className="ask-head">
        <span className="ask-asking">{subjectName(building)} is asking {ASKING[ask.type]}</span>
        {typeof ask.rank === "number" ? <Pill title="The Secretary's rank">#{ask.rank}</Pill> : null}
        <span className="muted">{timeAgo(ask.createdAt)}</span>
      </header>
      <h4 className="ask-title" title={ask.targetId ?? undefined}>{ask.title}</h4>
      {ask.status === "deferred" ? <div className="ask-stamp">Deferred until {ask.deferredUntil ?? "an event"}</div> : null}
      {delta ? <Markdown text={delta} className="ask-delta" /> : null}
      {ask.recommendation ? <div className="ask-rec"><span className="ask-label">Recommends</span> {ask.recommendation}</div> : null}
      {deciding
        ? <div className="ask-actions"><AskButtons ask={ask} grant={grant} retainer={retainer} onDecided={onDecided} deckSlide={deckSlide} consequences={split.byLabel} />{aside}</div>
        : (
          <div className="ask-actions">
            {Object.keys(split.byLabel).length ? (
              <div className="ask-branches with-conseq ask-branches-static">
                {ask.branches.filter((b) => split.byLabel[b.label]).map((b) => <div key={b.label} className="ask-branch"><span className="ask-branch-name">{b.label}</span><Markdown text={split.byLabel[b.label]!} className="ask-conseq" /></div>)}
              </div>
            ) : null}
            {aside}<span className="muted">{signedIn ? "A captain or admin decides this." : "Sign in to decide."}</span>
          </div>
        )}
      {rest ? <Markdown text={rest} className="ask-body" breaks /> : null}
      {grant ? <StepStrip grant={grant} /> : null}
      {ask.claims.length ? (
        <ul className="ask-claims">
          {ask.claims.map((c, i) => { const m = claimMark(c); return <li key={i} className={`ask-claim ${m.tone}`} title={c.check.ref ? `${c.check.kind}: ${c.check.ref}` : c.check.kind}><span className="ask-mark">{m.mark}</span> {c.text} <span className="muted">· {m.line}{c.result?.note ? ` · ${c.result.note}` : ""}</span></li>; })}
        </ul>
      ) : null}
      {steer || (ask.sourceDocId && onOpenRecord) ? (
        <div className="ask-foot">
          {steer ? <Act small run={async () => { const t = steerTarget(steer); if (t) await steerAsk(ask.id, t); }} title={`Open ${building}'s goal in the goal tree, with a 1:1 with its manager about this ask beside it`}>Steer</Act> : null}
          {ask.sourceDocId && onOpenRecord ? <button className="link ask-record" title={ask.sourceDocId} onClick={() => onOpenRecord(ask.sourceDocId!)}>The full record →</button> : null}
        </div>
      ) : null}
    </article>
  );
}
