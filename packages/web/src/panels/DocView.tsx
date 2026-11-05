/** One document: metadata, provenance, markdown, and the actions the viewer is permitted to take. */
import { forkTip } from "../forks";
import { useState, type ReactNode } from "react";
import type { Doc } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { Markdown, openDocLink } from "./Markdown";
import { docUrl } from "../route";
import { SkillDetails } from "./Skills";
import { ADJ, ADJ_HINT, Act, Pill, nameOf, timeAgo, fmtTokens, usd } from "./ui";
import { AttachButton } from "./AttachButton";
import { useMediaPaste } from "./mediaPaste";
import { MediaThumb } from "./MediaThumb";
import { requestDecisionLine, requestTone } from "./requests";
import { RollupReport, rollupCardsOf } from "./RollupCards";
import { PageDoc } from "./PageView";
import { DeckView } from "./DeckView";
import { canOneOnOne, openOneOnOne, talkTarget } from "./oneOnOne";

const DECISION_TONE: Record<string, string> = { pending: "warn", approve: "ok", continue: "ok", redirect: "info", stop: "bad" };
/** How a decision reads on a pill. `approve` is "Acknowledge" in v1.2: no assignment follows. */
const DECISION_LABEL: Record<string, string> = { pending: "in the in-tray", approve: "acknowledged", continue: "continued", redirect: "redirected", stop: "stopped" };
export const VERDICT_TONE: Record<string, string> = { continue: "ok", pivot: "info", stop: "bad" };

function DocMeta({ doc }: { doc: Doc }) {
  return (
    <div className="doc-meta">
      <Pill tone="type">{doc.type.replace(/-/g, " ")}</Pill>
      <Pill tone={`state-${doc.state}`}>{doc.state}</Pill>
      {doc.verdict ? <Pill tone={VERDICT_TONE[doc.verdict]} title="Agent's verdict">verdict: {doc.verdict}</Pill> : null}
      {doc.decision ? <Pill tone={DECISION_TONE[doc.decision]} title="Manager's decision">{decisionLabel(doc)}</Pill> : null}
      {doc.requestStatus ? <Pill tone={requestTone(doc.requestStatus)} title={doc.requestNote ? requestDecisionLine(doc) : undefined}>{doc.requestStatus}</Pill> : null}
    </div>
  );
}

/** Pill label: a decided report with a note (a reply, before replies were removed) reads "replied". */
function decisionLabel(doc: Pick<Doc, "decision" | "decisionNote">): string {
  if (!doc.decision) return "";
  if (doc.decision === "approve") return doc.decisionNote ? "replied" : "archived";
  return DECISION_LABEL[doc.decision] ?? doc.decision;
}

/**
 * A report's Archive (Mitchell, 1:1 mt_cz11aqe81a: after reading a report you talk to its author or archive it; there
 * is no reply). Archive acknowledges the report (decision "approve", no assignment) and it leaves the in-tray.
 */
function ArchiveButton({ doc, onDone, deckSlide, meetingId }: { doc: Doc; onDone?: () => void; deckSlide?: number; meetingId?: string }) {
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
function FlagDecideBox({ doc, onDone }: { doc: Doc; onDone?: () => void }) {
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
        <AttachButton small media={media} />
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
function TalkToAuthor({ doc }: { doc: Doc }) {
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
        {cost ? <> · <span title={docCostTitle(doc)}>{cost}</span></> : null}
        {doc.location ? <> · at {doc.location}</> : null}
        {" · "}<CopyLink id={doc.id} />
      </div>
      {doc.decisionNote && !doc.body.includes("## Reply from") ? <div className="callout"><b>{nameOf(doc.decidedBy)}:</b> {doc.decisionNote}</div> : null}
      {doc.type === "deck" ? <DeckView id={doc.id} body={doc.body} /> : doc.type === "page" ? <PageDoc doc={doc} /> : cards ? <RollupReport parsed={cards} /> : <Markdown text={doc.type === "skill" ? doc.body.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "") : stripLeadingH1(doc.body)} />}
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
        // folded (progressive disclosure, 1:1 mt_i50xwu4z2t): a rollup's covered reports are the record, not the read
        <details className="provenance">
          <summary>Provenance · {sources.length + doc.provenance.urls.length} source{sources.length + doc.provenance.urls.length === 1 ? "" : "s"}</summary>
          <ul>
            {sources.map((id) => <li key={id}><button className="link" onClick={() => void openDocLink(id)}>{store.state.docs[id]?.title ?? id}</button></li>)}
            {doc.provenance.urls.map((u) => <li key={u}><a href={u} target="_blank" rel="noopener noreferrer">{u}</a></li>)}
          </ul>
        </details>
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
  return <button className="link doc-id" title={`Copy a link to this document (${id})`} onClick={() => void copy()}>Copy link</button>;
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

/** `unread`: a red "new" mark first in the meta line (the bulletin board's notes the signed-in human hasn't opened, flag dc_04q4h8s229). */
export function DocRow({ doc, onOpen, unread }: { doc: Doc; onOpen: () => void; unread?: boolean }) {
  const cost = docCost(doc);
  return (
    <button className="doc-row" onClick={onOpen}>
      <MediaThumb body={doc.body} />
      <div className="doc-row-title">{doc.title}</div>
      <div className="doc-row-meta">
        {unread ? <Pill tone="bad">new</Pill> : null}
        <Pill tone="type">{doc.type.replace(/-/g, " ")}</Pill>
        {doc.decision ? <Pill tone={DECISION_TONE[doc.decision]}>{decisionLabel(doc)}</Pill> : null}
        {doc.requestStatus ? <Pill tone={requestTone(doc.requestStatus)}>{doc.requestStatus}</Pill> : null}
        <span title={[forkTip(store.state.agents[doc.authorId], nameOf, doc.assignmentId, doc.sessionId), cost ? docCostTitle(doc) : ""].filter(Boolean).join("\n") || undefined}>{nameOf(doc.authorId)} · {timeAgo(doc.updatedAt)}{cost ? ` · ${cost}` : ""}</span>
      </div>
    </button>
  );
}

/** In plain words, what the work behind a report cost: "$0.84 of work · 42 steps" ("108k tokens of work" when no dollar figure is set); "" when none is set. The town's units are in docCostTitle. */
export function docCost(doc: Doc): string {
  return [
    doc.costUsd ? `${usd(doc.costUsd)} of work` : doc.tokens ? `${fmtTokens(doc.tokens)} tokens of work` : "",
    doc.turns ? `${doc.turns} ${doc.turns === 1 ? "step" : "steps"}` : "",
  ].filter(Boolean).join(" · ");
}

/** The tooltip on docCost: the same in the town's units (adjusted tokens, turns). */
export function docCostTitle(doc: Doc): string {
  return [
    "What the session behind it cost",
    doc.tokens ? `${fmtTokens(doc.tokens)} ${ADJ} (${ADJ_HINT})` : "",
    doc.turns ? `${doc.turns} ${doc.turns === 1 ? "turn" : "turns"}` : "",
  ].filter(Boolean).join("\n");
}

/** Imported/legacy docs often start with an H1 that duplicates the title shown above. */
function stripLeadingH1(body: string): string {
  return body.replace(/^\s*#\s+[^\n]*\n+/, "");
}
