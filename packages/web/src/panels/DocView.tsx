/** One document: metadata, provenance, markdown, and the actions the viewer is permitted to take. */
import { useState } from "react";
import type { Doc } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { Markdown, openDocLink } from "./Markdown";
import { docUrl } from "../route";
import { SkillDetails } from "./Skills";
import { ADJ, Act, Field, Pill, nameOf, timeAgo, fmtTokens, usd } from "./ui";
import { useMediaPaste } from "./mediaPaste";
import { MediaThumb } from "./MediaThumb";

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
      {doc.requestStatus ? <Pill tone={doc.requestStatus === "rejected" ? "bad" : "ok"}>{doc.requestStatus}</Pill> : null}
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
  const media = useMediaPaste(setText);
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
      <textarea {...media.props} rows={3} placeholder={'Reply… ("merge" tells the author to merge; paste or drop a screenshot; leave empty to archive)'} value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send().catch((err) => store.toast(String((err as Error).message ?? err), "bad")); } }} />
      <div className="actions">
        <Act tone={empty ? "ok" : "primary"} disabled={media.uploading > 0} run={send} title={empty ? "Mark handled. No assignment is created." : `Append your reply to the report and give it to ${author} as the next assignment`}>{empty ? "Archive" : "Send reply"}</Act>
      </div>
    </div>
  );
}

/**
 * Deciding a flag (a human's quick request): pick the resident who takes it, an optional note, and "Assign"
 * (`review` continue = the flag's text verbatim, redirect = the note with the flag as context), or "Handled" (approve).
 * Normally the building's manager agent does this in its team-lead session; the box is for in-trays humans work.
 */
export function FlagDecideBox({ doc, onDone }: { doc: Doc; onDone?: () => void }) {
  const residents = useTown((s) => Object.values(s.agents).filter((a) => a.kind === "resident" && (a.homeBuildingId ?? a.buildingId) === doc.buildingId && a.status !== "retired" && a.status !== "banned"));
  const [assigneeId, setAssigneeId] = useState("");
  const [note, setNote] = useState("");
  const media = useMediaPaste(setNote);
  const assignee = residents.find((a) => a.id === assigneeId);
  const decide = (decision: "approve" | "continue" | "redirect") => async () => {
    const d = await api().review(doc.id, { decision, note: note.trim(), ...(decision === "approve" ? {} : { assigneeId }) });
    store.putDocs([d]);
    store.toast(decision === "approve" ? "Flag marked handled." : `Flag assigned to ${assignee?.name ?? "the resident"}.`, "ok");
    onDone?.();
  };
  return (
    <div className="reply-box">
      <Field label="Who takes it">
        <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
          <option value="">Pick a resident…</option>
          {residents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.status})</option>)}
        </select>
      </Field>
      <textarea {...media.props} rows={2} placeholder="Optional note: with one, your note becomes the assignment and the flag is its context" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="actions">
        <Act small run={decide("approve")} title="Nothing to do: mark the flag handled, no assignment">Handled</Act>
        <Act small tone="primary" disabled={!assignee} run={decide(note.trim() ? "redirect" : "continue")} title={assignee ? `Give it to ${assignee.name} as a directed assignment` : "Pick a resident first"}>{assignee ? `Assign to ${assignee.name}` : "Assign"}</Act>
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
  const canReview = !!review && (doc.type === "report" || doc.type === "flag") && doc.decision === "pending" && store.can("building.review", b);
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
        {" · "}<CopyLink id={doc.id} />
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
      <Markdown text={doc.type === "skill" ? doc.body.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "") : stripLeadingH1(doc.body)} />
      {doc.type === "skill" ? <SkillDetails doc={doc} /> : null}
      {canReview ? doc.type === "flag" ? <FlagDecideBox doc={doc} onDone={onDecided} /> : <><ReplyBox doc={doc} onDone={onDecided} /><AskBox doc={doc} /></> : null}
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

/** The doc's id, which agents can cite in any body; click copies a shareable URL. */
function CopyLink({ id }: { id: string }) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(docUrl(id)); store.toast("Link copied", "ok"); }
    catch {
      if (legacyCopy(docUrl(id))) store.toast("Link copied", "ok");
      else store.toast(docUrl(id), "info");
    }
  };
  return <button className="link doc-id" title="Copy a link to this document" onClick={() => void copy()}>{id} ⧉</button>;
}

/** navigator.clipboard only exists on https/localhost; plain-http towns copy through a hidden textarea. */
function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  try { return document.execCommand("copy"); } catch { return false; } finally { ta.remove(); }
}

export function DocRow({ doc, onOpen }: { doc: Doc; onOpen: () => void }) {
  const cost = docCost(doc);
  return (
    <button className="doc-row" onClick={onOpen}>
      <MediaThumb body={doc.body} />
      <div className="doc-row-title">{doc.title}</div>
      <div className="doc-row-meta">
        <Pill tone="type">{doc.type.replace(/-/g, " ")}</Pill>
        {doc.decision ? <Pill tone={DECISION_TONE[doc.decision]}>{decisionLabel(doc)}</Pill> : null}
        {doc.requestStatus ? <Pill tone={doc.requestStatus === "rejected" ? "bad" : "ok"}>{doc.requestStatus}</Pill> : null}
        <span>{nameOf(doc.authorId)} · {timeAgo(doc.updatedAt)}{cost ? ` · ${cost}` : ""}</span>
      </div>
    </button>
  );
}

/** "$0.84 · 108k tokens · 42 turns" for reports that carry session usage; "" when none is set. */
export function docCost(doc: Doc): string {
  return [
    doc.costUsd ? usd(doc.costUsd) : "",
    doc.tokens ? `${fmtTokens(doc.tokens)} ${ADJ}` : "",
    doc.turns ? `${doc.turns} ${doc.turns === 1 ? "turn" : "turns"}` : "",
  ].filter(Boolean).join(" · ");
}

/** Imported/legacy docs often start with an H1 that duplicates the title shown above. */
function stripLeadingH1(body: string): string {
  return body.replace(/^\s*#\s+[^\n]*\n+/, "");
}
