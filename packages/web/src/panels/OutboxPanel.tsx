/**
 * Outbox: agents' requests for humans, open to everyone as soon as they are filed; anyone can claim and report back.
 * Admins can decline one with a note (the author hears why) or delete one; an author withdraws its own (`withdraw_request`,
 * or a request that replaces it; 1:1 mt_pr3347g2w2 decision 7). Three tabs, Pending / Claimed / Done (Mitchell, 1:1
 * mt_6kz0prkq8l); declined and withdrawn ones sit under Done with their note.
 */
import { useMemo, useState } from "react";
import type { Doc } from "@muster-town/schema";
import { api, type RequestAction } from "../api";
import { store, useTown } from "../state";
import { DocView } from "./DocView";
import { requestDecisionLine, requestGroup, requestTone } from "./requests";
import { Glyph, PanelShell } from "./PanelShell";
import { Act, Empty, ErrorLine, Loading, Pill, nameOf, timeAgo, useLoad } from "./ui";
import { Markdown } from "./Markdown";
import { AttachButton } from "./AttachButton";
import { useMediaPaste } from "./mediaPaste";

/** The three tabs (Mitchell, 1:1 mt_6kz0prkq8l): Pending = open, Claimed, Done = done plus the ones that left the outbox undone (declined, withdrawn, legacy rejected). */
const TABS: { tab: string; group: NonNullable<Doc["requestStatus"]>; empty: string }[] = [
  { tab: "Pending", group: "open", empty: "Nothing pending. When an agent needs something done in the world, it shows up here." },
  { tab: "Claimed", group: "claimed", empty: "Nobody is working on a request right now." },
  { tab: "Done", group: "done", empty: "No requests finished yet. Done ones sit here with the ones declined or withdrawn." },
];

export function OutboxPanel() {
  const rev = useTown((s) => s.rev);
  const list = useLoad(() => api().docs({ type: "request", limit: 200 }), [rev]);
  const reports = useLoad(() => api().docs({ type: "human-report", limit: 50 }), [rev]);
  const unclaimed = useTown((s) => s.outbox);
  const [open, setOpen] = useState<Doc | null>(null);
  const grouped = useMemo(() => {
    const m = new Map<string, Doc[]>();
    for (const d of list.data ?? []) { const k = requestGroup(d.requestStatus); m.set(k, [...(m.get(k) ?? []), d]); }
    return m;
  }, [list.data]);
  const tabs = [...TABS.map((t) => t.tab), "Human reports"];
  return (
    <PanelShell icon={<Glyph kind="outbox" />} title={<>Outbox {unclaimed ? <Pill tone="warn" title="Requests nobody has claimed yet">{unclaimed}</Pill> : null}</>} subtitle="Requests from agents for humans to do in the real world" tabs={tabs}>
      {(t) => {
        const tab = TABS.find((x) => x.tab === t);
        if (tab) {
          if (open) return <DocView doc={open} onBack={() => setOpen(null)} backLabel="Outbox" />;
          const items = grouped.get(tab.group) ?? [];
          return (
            <>
              <ErrorLine error={list.error} />
              {list.loading && !list.data ? <Loading /> : !items.length ? <Empty>{tab.empty}</Empty> : items.map((d) => <RequestCard key={d.id} doc={d} onOpen={() => setOpen(d)} />)}
            </>
          );
        }
        return reports.loading && !reports.data ? <Loading /> : !reports.data?.length ? <Empty>No human reports yet. Finish a request to add one; it lands in the library as a source.</Empty> : (
          <div className="doc-list">
            {reports.data.map((d) => (
              <button key={d.id} className="doc-row" onClick={() => store.open({ kind: "library", docId: d.id })}>
                <div className="doc-row-title">{d.title}</div>
                <div className="doc-row-meta"><span>{nameOf(d.authorId)} · {timeAgo(d.createdAt)}</span></div>
              </button>
            ))}
          </div>
        );
      }}
    </PanelShell>
  );
}

function RequestCard({ doc, onOpen }: { doc: Doc; onOpen: () => void }) {
  const me = useTown((s) => s.me);
  const [body, setBody] = useState("");
  const media = useMediaPaste(setBody);
  const [finishing, setFinishing] = useState(false);
  const canModerate = store.can("town.approve_request");
  const mine = doc.claimedByUserId && doc.claimedByUserId === me?.user.id;
  const act = (a: RequestAction, msg: string, b?: string) => async () => { const d = await api().request(doc.id, a, b); if (d) store.putDocs([d]); else store.dropDoc(doc.id); store.toast(msg, "ok"); };
  return (
    <div className="request">
      <div className="request-head">
        <button className="link title" onClick={onOpen}>{doc.title}</button>
        <Pill tone={requestTone(doc.requestStatus)}>{doc.requestStatus}</Pill>
      </div>
      <div className="request-meta">from {nameOf(doc.authorId)} · {timeAgo(doc.createdAt)}{doc.location ? ` · ${doc.location}` : ""}{doc.claimedByUserId ? ` · claimed by ${mine ? "you" : nameOf(doc.claimedByUserId)}` : ""}</div>
      {doc.requestNote ? <div className="request-meta">{requestDecisionLine(doc)}</div> : null}
      <Markdown text={doc.body} className="compact" />
      <div className="actions">
        {doc.requestStatus === "open" ? <Act small tone="primary" run={act("claim", "Claimed. Report back when you're done.")}>Claim</Act> : null}
        {doc.requestStatus === "claimed" && (mine || canModerate) && !finishing ? <button className="btn sm ok" onClick={() => setFinishing(true)}>Report back…</button> : null}
        {doc.requestStatus === "open" && canModerate ? <Act small tone="warn" title="It leaves the outbox; the author hears your note" run={async () => { const note = window.prompt(`Decline "${doc.title}"? Say why (the author hears it):`); if (note?.trim()) await act("decline", "Request declined; the author was told", note.trim())(); }}>Decline…</Act> : null}
        {canModerate ? <Act small tone="bad" run={async () => { if (window.confirm(`Delete the request "${doc.title}"? This can't be undone.`)) await act("delete", "Request deleted")(); }}>Delete</Act> : null}
      </div>
      {finishing ? (
        <div className="finish">
          <textarea {...media.props} rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What you did, what you observed, links, numbers with units, photos (paste or drop)…" />
          <div className="actions">
            <AttachButton small media={media} />
            <Act small tone="ok" disabled={!body.trim() || media.uploading > 0} run={async () => { await act("done", "Thanks! Your report is in the library.", body.trim())(); setFinishing(false); }}>Submit report</Act>
            <button className="btn sm" onClick={() => setFinishing(false)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

