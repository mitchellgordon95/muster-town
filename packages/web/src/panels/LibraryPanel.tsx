/** Library (search + filters + doc view). */
import { useEffect, useState } from "react";
import { DocState, DocType } from "@muster-town/schema";
import type { Doc } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { DocRow, DocView } from "./DocView";
import { Glyph, PanelShell } from "./PanelShell";
import { SkillList } from "./Skills";
import { Empty, ErrorLine, Loading, Tabs, useLoad } from "./ui";

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
  const [tab, setTab] = useState<"docs" | "skills">("docs");
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
          <Tabs tabs={[{ id: "docs", label: "Documents" }, { id: "skills", label: "Skills" }]} active={tab} onChange={(t) => setTab(t as "docs" | "skills")} />
          {tab === "skills" ? <SkillList /> : <>
          <div className="search">
            <input value={q} placeholder="Search titles and text…" onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="filters">
            <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
              <option value="">All types</option>
              {DocType.options.filter((t) => t !== "assignment-proposal" && t !== "notebook").map((t) => <option key={t} value={t}>{t.replace(/-/g, " ")}</option>)}
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
          </>}
        </>
      )}
    </PanelShell>
  );
}
