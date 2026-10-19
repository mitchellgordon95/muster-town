/** One document: metadata, provenance, markdown, and the actions the viewer is permitted to take. */
import { useState } from "react";
import type { Doc } from "@agent-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { Markdown, openDocLink } from "./Markdown";
import { Act, Pill, nameOf, timeAgo, fmtTokens, usd } from "./ui";

export const DECISION_TONE: Record<string, string> = { pending: "warn", approve: "ok", redirect: "info", stop: "bad" };
export const VERDICT_TONE: Record<string, string> = { continue: "ok", pivot: "info", stop: "bad" };

export function DocMeta({ doc }: { doc: Doc }) {
  return (
    <div className="doc-meta">
      <Pill tone="type">{doc.type.replace(/-/g, " ")}</Pill>
      <Pill tone={`state-${doc.state}`}>{doc.state}</Pill>
      {doc.verdict ? <Pill tone={VERDICT_TONE[doc.verdict]} title="Agent's verdict">verdict: {doc.verdict}</Pill> : null}
      {doc.decision ? <Pill tone={DECISION_TONE[doc.decision]} title="Review decision">{doc.decision === "pending" ? "pending review" : doc.decision}</Pill> : null}
      {doc.requestStatus ? <Pill tone={doc.requestStatus === "proposed" ? "warn" : doc.requestStatus === "rejected" ? "bad" : "ok"}>{doc.requestStatus}</Pill> : null}
    </div>
  );
}

export function ReviewBox({ doc, onDone }: { doc: Doc; onDone?: () => void }) {
  const [note, setNote] = useState("");
  const decide = (decision: "approve" | "redirect" | "stop") => async () => {
    if (decision === "redirect" && !note.trim()) { store.toast("Add a note saying where to redirect.", "bad"); return; }
    const d = await api().review(doc.id, { decision, note });
    store.putDocs([d]);
    store.toast(`Report ${decision === "approve" ? "approved" : decision === "redirect" ? "redirected" : "stopped"}`, "ok");
    onDone?.();
  };
  return (
    <div className="review-box">
      <div className="review-title">This report is waiting for a decision</div>
      <textarea rows={3} placeholder="Note to the agent (required for Redirect)…" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="actions">
        <Act tone="ok" run={decide("approve")}>Approve</Act>
        <Act tone="warn" run={decide("redirect")}>Redirect</Act>
        <Act tone="bad" run={decide("stop")}>Stop</Act>
      </div>
    </div>
  );
}

export function DocView({ doc: initial, onBack, backLabel = "Back" }: { doc: Doc; onBack?: () => void; backLabel?: string }) {
  const live = useTown((s) => s.docs[initial.id]);
  const doc = live && live.updatedAt >= initial.updatedAt ? live : initial;
  useTown((s) => s.me); // re-render when permissions arrive
  const b = doc.buildingId;
  const canReview = doc.type === "report" && doc.decision === "pending" && store.can("building.review", b);
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
      {canReview ? <ReviewBox doc={doc} /> : null}
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
        {doc.decision === "pending" ? <Pill tone="warn">pending review</Pill> : null}
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
