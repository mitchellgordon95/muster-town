/** One document: metadata, provenance, markdown, and the actions the viewer is permitted to take. */
import { useState } from "react";
import type { Doc, ReviewDecision } from "@agent-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { Markdown, openDocLink } from "./Markdown";
import { Act, Pill, nameOf, timeAgo, fmtTokens, usd } from "./ui";

export const DECISION_TONE: Record<string, string> = { pending: "warn", approve: "ok", continue: "ok", redirect: "info", stop: "bad" };
/** How a decision reads on a pill. `approve` is "Acknowledge" in v1.2: no assignment follows. */
export const DECISION_LABEL: Record<string, string> = { pending: "in the in-tray", approve: "acknowledged", continue: "continued", redirect: "redirected", stop: "stopped" };
export const VERDICT_TONE: Record<string, string> = { continue: "ok", pivot: "info", stop: "bad" };

export function DocMeta({ doc }: { doc: Doc }) {
  return (
    <div className="doc-meta">
      <Pill tone="type">{doc.type.replace(/-/g, " ")}</Pill>
      <Pill tone={`state-${doc.state}`}>{doc.state}</Pill>
      {doc.verdict ? <Pill tone={VERDICT_TONE[doc.verdict]} title="Agent's verdict">verdict: {doc.verdict}</Pill> : null}
      {doc.decision ? <Pill tone={DECISION_TONE[doc.decision]} title="Manager's decision">{DECISION_LABEL[doc.decision] ?? doc.decision}</Pill> : null}
      {doc.requestStatus ? <Pill tone={doc.requestStatus === "proposed" ? "warn" : doc.requestStatus === "rejected" ? "bad" : "ok"}>{doc.requestStatus}</Pill> : null}
    </div>
  );
}

/** The report's "Proposal for next session" section, first paragraph (what Continue as proposed assigns). */
export function proposalOf(body: string): string | null {
  const m = /^##+\s*Proposal[^\n]*\n+([\s\S]*?)(?=\n##+\s|$)/im.exec(body);
  const t = m?.[1]?.trim();
  return t ? t : null;
}

type Decision = ReviewDecision;
const DONE_MSG: Record<Decision, string> = {
  approve: "Acknowledged. No new assignment.",
  continue: "Continuing as proposed: assignment created.",
  redirect: "Redirected: assignment created from your note.",
  stop: "Stopped. Pending assignments cancelled.",
};

/** In-tray decision box: Acknowledge / Continue as proposed / Redirect… (note required) / Stop. */
export function ReviewBox({ doc, onDone }: { doc: Doc; onDone?: () => void }) {
  const [note, setNote] = useState("");
  const [redirecting, setRedirecting] = useState(false);
  const proposal = proposalOf(doc.body);
  const decide = (decision: Decision) => async () => {
    if (decision === "redirect" && !note.trim()) { store.toast("Redirect needs a note saying what to do instead.", "bad"); return; }
    const d = await api().review(doc.id, { decision, note: note.trim() });
    store.putDocs([d]);
    store.toast(DONE_MSG[decision], "ok");
    onDone?.();
  };
  return (
    <div className="review-box">
      <div className="review-title">Decide on this report</div>
      {proposal ? <div className="review-proposal"><span>Proposal</span>{proposal.length > 280 ? proposal.slice(0, 280) + "…" : proposal}</div> : <div className="review-proposal muted">No proposal section; Continue will assign a follow-up from the report.</div>}
      {redirecting ? (
        <textarea rows={3} autoFocus placeholder="What should they do instead? (required; the proposal is appended as context)" value={note} onChange={(e) => setNote(e.target.value)} />
      ) : (
        <textarea rows={2} placeholder="Optional note to the agent…" value={note} onChange={(e) => setNote(e.target.value)} />
      )}
      <div className="actions">
        {redirecting ? <>
          <Act tone="warn" disabled={!note.trim()} run={decide("redirect")}>Redirect</Act>
          <button className="btn" onClick={() => setRedirecting(false)}>Cancel</button>
        </> : <>
          <Act tone="ok" run={decide("approve")} title="Mark handled. No assignment is created.">Acknowledge</Act>
          <Act tone="primary" run={decide("continue")} title="Acknowledge and assign the report's proposal">Continue as proposed</Act>
          <button className="btn warn" onClick={() => setRedirecting(true)} title="Acknowledge and assign your note instead">Redirect…</button>
          <Act tone="bad" run={decide("stop")} title="Acknowledge, stop the agent, cancel its pending assignments">Stop</Act>
        </>}
      </div>
    </div>
  );
}

/** `review`: show the decision box (only the in-tray passes it; decisions happen at the manager's desk). */
export function DocView({ doc: initial, onBack, backLabel = "Back", review, onDecided }: { doc: Doc; onBack?: () => void; backLabel?: string; review?: boolean; onDecided?: () => void }) {
  const live = useTown((s) => s.docs[initial.id]);
  const doc = live && live.updatedAt >= initial.updatedAt ? live : initial;
  useTown((s) => s.me); // re-render when permissions arrive
  const b = doc.buildingId;
  const canReview = !!review && doc.type === "report" && doc.decision === "pending" && store.can("building.review", b);
  const canPromote = store.can("building.promote", b);
  const canTrophy = store.can("town.approve_trophy");
  const run = (fn: () => Promise<Doc>, msg: string) => async () => { const d = await fn(); store.putDocs([d]); store.toast(msg, "ok"); };
  const sources = doc.provenance.sourceIds;
  return (
    <article className="doc">
      {onBack ? <button className="link back" onClick={onBack}>← {backLabel}</button> : null}
      <h2 className="doc-title">{doc.title}</h2>
      <DocMeta doc={doc} />
      <div className="doc-byline">
        by <b>{nameOf(doc.authorId)}</b> · {timeAgo(doc.createdAt)}
        {doc.tokens ? <> · {fmtTokens(doc.tokens)} tokens</> : null}
        {doc.costUsd ? <> · {usd(doc.costUsd)}</> : null}
        {doc.location ? <> · at {doc.location}</> : null}
      </div>
      {doc.decisionNote ? <div className="callout"><b>{nameOf(doc.decidedBy)}:</b> {doc.decisionNote}</div> : null}
      {doc.trophyProposedBy ? <div className="callout gold"><b>Trophy proposal</b> by {nameOf(doc.trophyProposedBy)}{doc.trophyWhy ? `: ${doc.trophyWhy}` : ""}</div> : null}
      {canReview ? <ReviewBox doc={doc} onDone={onDecided} /> : null}
      <div className="actions">
        {canPromote && doc.state === "draft" ? <Act small run={run(() => api().promote(doc.id, "building"), "Published to the board")}>Publish to board</Act> : null}
        {canPromote && doc.state === "building" ? <Act small run={run(() => api().promote(doc.id, "library"), "Promoted to the library")}>Promote to library</Act> : null}
        {canTrophy && doc.trophyProposedBy && doc.state !== "trophy" ? <>
          <Act small tone="ok" run={run(() => api().trophy(doc.id, true), "Moved to the trophy room")}>Accept trophy</Act>
          <Act small run={run(() => api().trophy(doc.id, false), "Trophy proposal declined")}>Decline</Act>
        </> : null}
      </div>
      <Markdown text={stripLeadingH1(doc.body)} />
      {sources.length || doc.provenance.urls.length ? (
        <div className="provenance">
          <h4>Provenance</h4>
          <ul>
            {sources.map((id) => <li key={id}><button className="link" onClick={() => void openDocLink(id)}>{store.state.docs[id]?.title ?? id}</button></li>)}
            {doc.provenance.urls.map((u) => <li key={u}><a href={u} target="_blank" rel="noopener noreferrer">{u}</a></li>)}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

export function DocRow({ doc, onOpen }: { doc: Doc; onOpen: () => void }) {
  return (
    <button className="doc-row" onClick={onOpen}>
      <div className="doc-row-title">{doc.title}</div>
      <div className="doc-row-meta">
        <Pill tone="type">{doc.type.replace(/-/g, " ")}</Pill>
        {doc.decision ? <Pill tone={DECISION_TONE[doc.decision]}>{DECISION_LABEL[doc.decision]}</Pill> : null}
        {doc.requestStatus ? <Pill tone={doc.requestStatus === "proposed" ? "warn" : "ok"}>{doc.requestStatus}</Pill> : null}
        <span>{nameOf(doc.authorId)} · {timeAgo(doc.updatedAt)}</span>
      </div>
    </button>
  );
}

/** Imported/legacy docs often start with an H1 that duplicates the title shown above. */
function stripLeadingH1(body: string): string {
  return body.replace(/^\s*#\s+[^\n]*\n+/, "");
}
