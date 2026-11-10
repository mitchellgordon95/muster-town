/** Library (search + filters + the list; a doc opens in the link sheet). */
import { useEffect, useState } from "react";
import { DocState, DocType } from "@muster-town/schema";
import type { Doc } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { DocRow } from "./DocView";
import { Glyph, PanelShell } from "./PanelShell";
import { SkillList } from "./Skills";
import { Empty, ErrorLine, Loading, Tabs, useLoad } from "./ui";

/** The library's list; a doc opens in the link sheet over it (gr_4csjpgh346 step 3), so closing the doc is back on the list. */
/** Documents the library list shows before "Show the other N". */
const LIB_FIRST = 6;

export function LibraryPanel() {
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
  const shown = useTown((s) => (s.sheet?.kind === "doc" ? s.sheet.id : null));
  // a new search or filter starts on the newest few again
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [debounced, type, state, buildingId]);

  return (
    <PanelShell icon={<Glyph kind="library" />} title="Library" subtitle="Everything the town knows, with sources">
      <>
          <Tabs tabs={[{ id: "docs", label: "Documents" }, { id: "skills", label: "Skills" }]} active={tab} onChange={(t) => setTab(t as "docs" | "skills")} />
          {tab === "skills" ? <SkillList /> : <>
          <div className="search">
            <input value={q} placeholder="Search titles and text…" onChange={(e) => setQ(e.target.value)} />
          </div>
          {/* the three filters fold under one line that says what is set (gr_zak30564zh step 5): the list opens on search and documents */}
          <details className="kr-more lib-filters">
          <summary>Filter{type || state || buildingId ? `: ${[type && type.replace(/-/g, " "), state && (state === "building" ? "on a board" : state), buildingId && (buildings.find((b) => b.id === buildingId)?.name ?? buildingId)].filter(Boolean).join(", ")}` : " by type, state or building"}</summary>
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
          </details>
          <ErrorLine error={list.error} />
          {list.loading && !list.data ? <Loading /> : !list.data?.length ? <Empty>No documents match.</Empty> : (
            <>
              <div className="count">{list.data.length} document{list.data.length === 1 ? "" : "s"}</div>
              {/* the newest few, the rest one click away: the list opens on what is new (gr_zak30564zh step 5, kr_p6l1w6tade) */}
              <div className="doc-list">{(showAll ? list.data : list.data.slice(0, LIB_FIRST)).map((d) => <DocRow key={d.id} doc={d} selected={shown === d.id} onOpen={() => store.openSheet({ kind: "doc", id: d.id })} />)}</div>
              {!showAll && list.data.length > LIB_FIRST ? <button type="button" className="btn sm lib-more" onClick={() => setShowAll(true)}>Show the other {list.data.length - LIB_FIRST}</button> : null}
            </>
          )}
          </>}
      </>
    </PanelShell>
  );
}
