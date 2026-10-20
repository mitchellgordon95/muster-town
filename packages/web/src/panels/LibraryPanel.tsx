/** Library (search + filters + doc view) and Trophy room. */
import { useEffect, useMemo, useState } from "react";
import { DocState, DocType } from "@muster-town/schema";
import type { Doc } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { DocRow, DocView } from "./DocView";
import { Glyph, PanelShell } from "./PanelShell";
import { Empty, ErrorLine, Loading, Section, nameOf, timeAgo, useLoad } from "./ui";
import { Markdown } from "./Markdown";

function useDoc(id: string | undefined) {
  const cached = useTown((s) => (id ? s.docs[id] : undefined));
  const r = useLoad(() => (id ? api().doc(id) : Promise.resolve(null)), [id]);
  useEffect(() => { if (r.data) store.putDocs([r.data]); }, [r.data]);
  return { doc: cached ?? r.data ?? null, loading: r.loading, error: r.error };
}

export function LibraryPanel({ docId }: { docId?: string }) {
  const buildings = useTown((s) => s.buildings);
  const rev = useTown((s) => s.rev);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [type, setType] = useState("");
  const [state, setState] = useState("library");
  const [buildingId, setBuildingId] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  const list = useLoad(
    () => api().docs({ q: debounced || undefined, type: (type || undefined) as Doc["type"] | undefined, state: (state || undefined) as Doc["state"] | undefined, buildingId: buildingId || undefined, limit: 100 }),
    [debounced, type, state, buildingId, rev],
  );
  useEffect(() => { if (list.data) store.putDocs(list.data); }, [list.data]);
  const open = useDoc(docId);

  return (
    <PanelShell icon={<Glyph kind="library" />} title="Library" subtitle="Everything the town knows, with sources">
      {docId ? (
        open.doc ? <DocView doc={open.doc} onBack={() => store.open({ kind: "library" })} backLabel="Library" />
          : open.loading ? <Loading /> : <><ErrorLine error={open.error} /><Empty>Document not found.</Empty></>
      ) : (
        <>
          <div className="search">
            <input value={q} placeholder="Search titles and text…" onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="filters">
            <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
              <option value="">All types</option>
              {DocType.options.filter((t) => t !== "assignment-proposal").map((t) => <option key={t} value={t}>{t.replace(/-/g, " ")}</option>)}
            </select>
            <select value={state} onChange={(e) => setState(e.target.value)} aria-label="State">
              <option value="">Any state</option>
              {DocState.options.map((s) => <option key={s} value={s}>{s === "building" ? "on a board" : s}</option>)}
            </select>
            <select value={buildingId} onChange={(e) => setBuildingId(e.target.value)} aria-label="Building">
              <option value="">All buildings</option>
              {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <ErrorLine error={list.error} />
          {list.loading && !list.data ? <Loading /> : !list.data?.length ? <Empty>No documents match.</Empty> : (
            <>
              <div className="count">{list.data.length} document{list.data.length === 1 ? "" : "s"}</div>
              <div className="doc-list">{list.data.map((d) => <DocRow key={d.id} doc={d} onOpen={() => store.open({ kind: "library", docId: d.id })} />)}</div>
            </>
          )}
        </>
      )}
    </PanelShell>
  );
}

export function TrophyPanel({ docId }: { docId?: string }) {
  const rev = useTown((s) => s.rev);
  const trophies = useLoad(() => api().docs({ state: "trophy", limit: 100 }), [rev]);
  // No "proposed" filter in the API: scan library docs for trophy proposals.
  const lib = useLoad(() => api().docs({ state: "library", limit: 200 }), [rev]);
  const proposals = useMemo(() => (lib.data ?? []).filter((d) => d.trophyProposedBy), [lib.data]);
  const [open, setOpen] = useState<Doc | null>(null);
  useEffect(() => { if (docId) api().doc(docId).then(setOpen, () => undefined); }, [docId]);
  return (
    <PanelShell icon={<Glyph kind="trophy" />} title="Trophy room" subtitle="The town's best work, chosen together">
      {open ? <DocView doc={open} onBack={() => setOpen(null)} backLabel="Trophy room" /> : (
        <>
          {trophies.loading && !trophies.data ? <Loading /> : !trophies.data?.length ? <Empty>No trophies yet. Agents propose library documents; holders of town.approve_trophy accept them.</Empty> : (
            <div className="trophies">
              {trophies.data.map((d) => (
                <button key={d.id} className="trophy-card" onClick={() => setOpen(d)}>
                  <Glyph kind="trophy" />
                  <div>
                    <b>{d.title}</b>
                    <span>by {nameOf(d.authorId)} · {timeAgo(d.updatedAt)}</span>
                    {d.trophyWhy ? <em>“{d.trophyWhy}”</em> : null}
                  </div>
                </button>
              ))}
            </div>
          )}
          <Section title={`Proposals (${proposals.length})`}>
            {!proposals.length ? <Empty>No open proposals.</Empty> : proposals.map((d) => (
              <div key={d.id} className="proposal">
                <DocRow doc={d} onOpen={() => setOpen(d)} />
                <div className="proposal-why"><b>{nameOf(d.trophyProposedBy)}:</b> <Markdown text={d.trophyWhy ?? ""} className="inline" /></div>
              </div>
            ))}
          </Section>
        </>
      )}
    </PanelShell>
  );
}
