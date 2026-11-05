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

  return (
    <PanelShell icon={<Glyph kind="library" />} title="Library" subtitle="Everything the town knows, with sources">
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
              <div className="doc-list">{list.data.map((d) => <DocRow key={d.id} doc={d} selected={shown === d.id} onOpen={() => store.openSheet({ kind: "doc", id: d.id })} />)}</div>
            </>
          )}
          </>}
      </>
    </PanelShell>
  );
}
