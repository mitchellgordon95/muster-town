/** One document: metadata, provenance, markdown, and the actions the viewer is permitted to take. */
import { useState } from "react";
import type { Doc } from "@agent-town/schema";
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
      {doc.decision ? <Pill tone={DECISION_TONE[doc.decision]} title="Manager's decision">{decisionLabel(doc)}</Pill> : null}
      {doc.requestStatus ? <Pill tone={doc.requestStatus === "proposed" ? "warn" : doc.requestStatus === "rejected" ? "bad" : "ok"}>{doc.requestStatus}</Pill> : null}
    </div>
  );
}

/** First line of the report's "What I need from you" section, or null. */
export function needOf(body: string): string | null {
  const m = /^##+\s*What I need from you[^\n]*\n+([\s\S]*?)(?=\n##+\s|$)/im.exec(body);
  const line = m?.[1]?.split("\n").map((l) => l.replace(/^[-*]\s+/, "").trim()).find(Boolean);
  return line ?? null;
}

/** Pill label: a decided report with a reply note reads "replied". */
export function decisionLabel(doc: Pick<Doc, "decision" | "decisionNote">): string {
  if (!doc.decision) return "";
  if (doc.decision === "approve") return doc.decisionNote ? "replied" : "archived";
  return DECISION_LABEL[doc.decision] ?? doc.decision;
}

/**
 * Reports as replies: one text box, one button. The reply is appended to the report, mentions the author, and
 * becomes the author's next assignment. "merge" tells the author to merge its PR. Empty = archive.
 */
export function ReplyBox({ doc, onDone }: { doc: Doc; onDone?: () => void }) {
  const [text, setText] = useState("");
  const empty = !text.trim();
  const author = nameOf(doc.authorId);
  const send = async () => {
    const r = empty ? await api().archive(doc.id) : await api().reply(doc.id, text.trim());
    store.putDocs([r.doc]);
    store.toast(empty ? "Archived." : r.assignment ? `Reply sent. ${author} picks it up next.` : `Reply recorded. ${author} gets no new assignment.`, "ok");
    setText("");
    onDone?.();
  };
  return (
    <div className="reply-box">
      <textarea rows={3} placeholder={'Reply… ("merge" tells the author to merge; leave empty to archive)'} value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send().catch((err) => store.toast(String((err as Error).message ?? err), "bad")); } }} />
      <div className="actions">
        <Act tone={empty ? "ok" : "primary"} run={send} title={empty ? "Mark handled. No assignment is created." : `Append your reply to the report and give it to ${author} as the next assignment`}>{empty ? "Archive" : "Send reply"}</Act>
      </div>
    </div>
  );
}

type AskTurn = { role: "user" | "assistant"; text: string };

/** "Ask about this": questions about the report, answered without bothering its author. */
export function AskBox({ doc }: { doc: Doc }) {
  const [q, setQ] = useState("");
  const [history, setHistory] = useState<AskTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(true);
    setQ("");
    const prior = history;
    setHistory([...prior, { role: "user", text: question }]);
    try {
      const reply = await api().ask(doc.id, question, prior);
      setHistory((h) => [...h, { role: "assistant" as const, text: reply }].slice(-12));
    } catch (e) {
      setHistory((h) => [...h, { role: "assistant", text: `(No answer: ${(e as Error).message ?? e})` }]);
    } finally { setBusy(false); }
  };
  return (
    <div className="ask-box">
      <div className="ask-title">Ask about this <span>answered from the report and {nameOf(doc.authorId)}'s recent activity; {nameOf(doc.authorId)} isn't interrupted</span></div>
      {history.length ? (
        <div className="ask-log">
          {history.map((t, i) => <div key={i} className={`ask-turn ${t.role}`}>{t.role === "user" ? <b>You: </b> : null}{t.text}</div>)}
          {busy ? <div className="ask-turn assistant muted">…</div> : null}
        </div>
      ) : null}
      <form className="ask-form" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
        <input value={q} placeholder="What does the PR change? Is anything still failing?" onChange={(e) => setQ(e.target.value)} />
        <button className="btn" type="submit" disabled={!q.trim() || busy}>Ask</button>
      </form>
    </div>
  );
}

/** `review`: show the reply box and Ask about this under the body (only the in-tray passes it). */
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
  const cost = docCost(doc);
  return (
    <article className="doc">
      {onBack ? <button className="link back" onClick={onBack}>← {backLabel}</button> : null}
      <h2 className="doc-title">{doc.title}</h2>
      <DocMeta doc={doc} />
      <div className="doc-byline">
        by <b>{nameOf(doc.authorId)}</b> · {timeAgo(doc.createdAt)}
        {cost ? <> · <span title="What this session cost">{cost}</span></> : null}
        {doc.location ? <> · at {doc.location}</> : null}
      </div>
      {doc.decisionNote && !doc.body.includes("## Reply from") ? <div className="callout"><b>{nameOf(doc.decidedBy)}:</b> {doc.decisionNote}</div> : null}
      {doc.trophyProposedBy ? <div className="callout gold"><b>Trophy proposal</b> by {nameOf(doc.trophyProposedBy)}{doc.trophyWhy ? `: ${doc.trophyWhy}` : ""}</div> : null}
      <div className="actions">
        {canPromote && doc.state === "draft" ? <Act small run={run(() => api().promote(doc.id, "building"), "Published to the board")}>Publish to board</Act> : null}
        {canPromote && doc.state === "building" ? <Act small run={run(() => api().promote(doc.id, "library"), "Promoted to the library")}>Promote to library</Act> : null}
        {canTrophy && doc.trophyProposedBy && doc.state !== "trophy" ? <>
          <Act small tone="ok" run={run(() => api().trophy(doc.id, true), "Moved to the trophy room")}>Accept trophy</Act>
          <Act small run={run(() => api().trophy(doc.id, false), "Trophy proposal declined")}>Decline</Act>
        </> : null}
      </div>
      <Markdown text={stripLeadingH1(doc.body)} />
      {canReview ? <><ReplyBox doc={doc} onDone={onDecided} /><AskBox doc={doc} /></> : null}
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
  const cost = docCost(doc);
  return (
    <button className="doc-row" onClick={onOpen}>
      <div className="doc-row-title">{doc.title}</div>
      <div className="doc-row-meta">
        <Pill tone="type">{doc.type.replace(/-/g, " ")}</Pill>
        {doc.decision ? <Pill tone={DECISION_TONE[doc.decision]}>{decisionLabel(doc)}</Pill> : null}
        {doc.requestStatus ? <Pill tone={doc.requestStatus === "proposed" ? "warn" : "ok"}>{doc.requestStatus}</Pill> : null}
        <span>{nameOf(doc.authorId)} · {timeAgo(doc.updatedAt)}{cost ? ` · ${cost}` : ""}</span>
      </div>
    </button>
  );
}

/** "$0.84 · 108k tokens · 42 turns" for reports that carry session usage; "" when none is set. */
export function docCost(doc: Doc): string {
  return [
    doc.costUsd ? usd(doc.costUsd) : "",
    doc.tokens ? `${fmtTokens(doc.tokens)} tokens` : "",
    doc.turns ? `${doc.turns} ${doc.turns === 1 ? "turn" : "turns"}` : "",
  ].filter(Boolean).join(" · ");
}

/** Imported/legacy docs often start with an H1 that duplicates the title shown above. */
function stripLeadingH1(body: string): string {
  return body.replace(/^\s*#\s+[^\n]*\n+/, "");
}
