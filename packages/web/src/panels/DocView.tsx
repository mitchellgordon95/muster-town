/** One document: metadata, provenance, markdown, and the actions the viewer is permitted to take. */
import { forkTip } from "../forks";
import { useState, type ReactNode } from "react";
import type { Doc } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { Markdown, openDocLink } from "./Markdown";
import { docUrl } from "../route";
import { SkillDetails } from "./Skills";
import { ADJ, Act, Pill, nameOf, timeAgo, fmtTokens, usd } from "./ui";
import { useMediaPaste } from "./mediaPaste";
import { MediaThumb } from "./MediaThumb";
import { RollupCards, rollupCardsOf } from "./RollupCards";
import { DeckView } from "./DeckView";
import { canOneOnOne, openOneOnOne, talkTarget } from "./oneOnOne";

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

/** Pill label: a decided report with a note (a reply, before replies were removed) reads "replied". */
export function decisionLabel(doc: Pick<Doc, "decision" | "decisionNote">): string {
  if (!doc.decision) return "";
  if (doc.decision === "approve") return doc.decisionNote ? "replied" : "archived";
  return DECISION_LABEL[doc.decision] ?? doc.decision;
}

/**
 * A report's Archive (Mitchell, 1:1 mt_cz11aqe81a: after reading a report you talk to its author or archive it; there
 * is no reply). Archive acknowledges the report (decision "approve", no assignment) and it leaves the in-tray.
 */
export function ArchiveButton({ doc, onDone, deckSlide, meetingId }: { doc: Doc; onDone?: () => void; deckSlide?: number; meetingId?: string }) {
  const archive = async () => {
    const r = await api().archive(doc.id, deckSlide, meetingId);
    store.putDocs([r.doc]);
    store.toast("Archived.", "ok");
    onDone?.();
  };
  return <Act tone="ok" run={archive} title="Mark it handled: it leaves the in-tray. No assignment is created.">Archive</Act>;
}

/** A pending report's two actions: Talk to the author (a 1:1) and Archive, as a big footer under the report. */
export function ReportActions({ doc, onDone, deckSlide, meetingId, children }: { doc: Doc; onDone?: () => void; deckSlide?: number; meetingId?: string; children?: ReactNode }) {
  return <div className="actions report-actions decide-footer"><TalkToAuthor doc={doc} /><ArchiveButton doc={doc} onDone={onDone} deckSlide={deckSlide} meetingId={meetingId} />{children}</div>;
}

/**
 * Deciding a flag (a human's quick request): an optional note, then "Queue it" (`review` continue = the flag's text
 * verbatim, redirect = the note with the flag as context) onto the building queue, where a fork of the manager runs it,
 * or "Handled" (approve). Normally the manager agent does this in its team-lead session (1:1 mt_wngibcr98b decision 1:
 * no residents to pick from).
 */
export function FlagDecideBox({ doc, onDone }: { doc: Doc; onDone?: () => void }) {
  const manager = useTown((s) => {
    const b = s.buildings.find((x) => x.id === doc.buildingId);
    return b?.managerAgentId ? s.agents[b.managerAgentId] : undefined;
  });
  const [note, setNote] = useState("");
  const media = useMediaPaste(setNote);
  const decide = (decision: "approve" | "continue" | "redirect") => async () => {
    const d = await api().review(doc.id, { decision, note: note.trim() });
    store.putDocs([d]);
    store.toast(decision === "approve" ? "Flag marked handled." : `Flag queued: a fork of ${manager?.name ?? "the manager"} runs it.`, "ok");
    onDone?.();
  };
  return (
    <div className="reply-box">
      <textarea {...media.props} rows={2} placeholder="Optional note: with one, your note becomes the assignment and the flag is its context" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="actions">
        <Act small run={decide("approve")} title="Nothing to do: mark the flag handled, no assignment">Handled</Act>
        <Act small tone="primary" disabled={!manager} run={decide(note.trim() ? "redirect" : "continue")} title={manager ? `Queue it to the building as a directed assignment: a fork of ${manager.name} runs it` : "This building has no manager agent to run it"}>Queue it</Act>
      </div>
    </div>
  );
}

/**
 * A doc's "Talk to <author>" (Mitchell, 1:1s mt_uf1bwd3exq for reports, mt_u6euky43hg for every type): opens my 1:1
 * with the author, the doc presented as the first line. A fork's doc (or a gone author's) reaches its manager, and the
 * button says so. A human's doc has none.
 */
export function TalkToAuthor({ doc }: { doc: Doc }) {
  const agents = useTown((s) => s.agents);
  const buildings = useTown((s) => s.buildings);
  const me = useTown((s) => s.me);
  const t = talkTarget(doc.authorId, agents, buildings);
  const home = t ? t.agent.homeBuildingId ?? t.agent.buildingId : null;
  if (!me || !t || !canOneOnOne(home)) return null;
  const why = t.via === "fork" ? `${nameOf(doc.authorId)} is a fork of ${t.agent.name}, so ${t.agent.name} answers` : t.via === "gone" ? `${nameOf(doc.authorId)} isn't working any more, so their manager ${t.agent.name} answers` : null;
  return (
    <span className="talk-author">
      <Act tone="primary" run={() => openOneOnOne(home!, { agentId: t.agent.id, docId: doc.id })} title={`Open a 1:1 with ${t.agent.name} about this ${doc.type.replace(/-/g, " ")}${why ? ` (${why})` : ""}`}>Talk to {t.agent.name}</Act>
      {why ? <span className="muted"> {why}</span> : null}
    </span>
  );
}

/** `review`: a pending report gets Talk to + Archive, a flag its decide box (only the in-tray passes it). */
export function DocView({ doc: initial, onBack, backLabel = "Back", review, onDecided }: { doc: Doc; onBack?: () => void; backLabel?: string; review?: boolean; onDecided?: () => void }) {
  const live = useTown((s) => s.docs[initial.id]);
  const doc = live && live.updatedAt >= initial.updatedAt ? live : initial;
  useTown((s) => s.me); // re-render when permissions arrive
  const b = doc.buildingId;
  const canReview = !!review && (doc.type === "report" || doc.type === "flag") && doc.decision === "pending" && store.can("building.review", b);
  const canPromote = store.can("building.promote", b);
  const run = (fn: () => Promise<Doc>, msg: string) => async () => { const d = await fn(); store.putDocs([d]); store.toast(msg, "ok"); };
  const sources = doc.provenance.sourceIds;
  const cost = docCost(doc);
  const cards = rollupCardsOf(doc);
  return (
    <article className="doc">
      {onBack ? <button className="link back" onClick={onBack}>← {backLabel}</button> : null}
      <h2 className="doc-title">{doc.title}</h2>
      <DocMeta doc={doc} />
      <div className="doc-byline">
        by <b title={forkTip(store.state.agents[doc.authorId], nameOf, doc.assignmentId, doc.sessionId) || undefined}>{nameOf(doc.authorId)}</b> · {timeAgo(doc.createdAt)}
        {cost ? <> · <span title="What this session cost">{cost}</span></> : null}
        {doc.location ? <> · at {doc.location}</> : null}
        {" · "}<CopyLink id={doc.id} />
      </div>
      {doc.decisionNote && !doc.body.includes("## Reply from") ? <div className="callout"><b>{nameOf(doc.decidedBy)}:</b> {doc.decisionNote}</div> : null}
      {doc.type === "deck" ? <DeckView id={doc.id} body={doc.body} /> : cards ? <RollupCards parsed={cards} full /> : <Markdown text={doc.type === "skill" ? doc.body.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "") : stripLeadingH1(doc.body)} />}
      {doc.type === "skill" ? <SkillDetails doc={doc} /> : null}
      {canReview && doc.type === "flag" ? <FlagDecideBox doc={doc} onDone={onDecided} /> : null}
      {/* the buttons that act on the doc come after reading it, big (Mitchell's flag dc_4uiv48047s) */}
      <div className="actions decide-footer">
        <TalkToAuthor doc={doc} />
        {canReview && doc.type === "report" ? <ArchiveButton doc={doc} onDone={onDecided} /> : null}
        {canPromote && doc.state === "draft" ? <Act run={run(() => api().promote(doc.id, "building"), "Published to the board")}>Publish to board</Act> : null}
        {canPromote && doc.state === "building" ? <Act run={run(() => api().promote(doc.id, "library"), "Promoted to the library")}>Promote to library</Act> : null}
      </div>
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
        <span title={forkTip(store.state.agents[doc.authorId], nameOf, doc.assignmentId, doc.sessionId) || undefined}>{nameOf(doc.authorId)} · {timeAgo(doc.updatedAt)}{cost ? ` · ${cost}` : ""}</span>
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
