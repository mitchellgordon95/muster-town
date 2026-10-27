/** Skills (docs/skills.md): the library's Skills tab, and a skill's files and pins under its doc. */
import { useState } from "react";
import type { Doc, SkillPinMode, SkillPinScope, SkillPinView, SkillView } from "@muster-town/schema";
import { api, API_BASE } from "../api";
import { store, useTown } from "../state";
import { Act, Empty, ErrorLine, Loading, Pill, Section, timeAgo, useLoad } from "./ui";

const SCOPE_LABEL: Record<SkillPinScope, string> = { agent: "agent", building: "building", town: "town" };

function pinLabel(p: SkillPinView): string {
  return `${p.scope === "town" ? "town-wide" : `${SCOPE_LABEL[p.scope]}: ${p.targetName ?? p.targetId}`} · ${p.mode}`;
}

/** The library's Skills tab: every skill with when to use it, its files, pins and uses. */
export function SkillList() {
  const rev = useTown((s) => s.rev);
  const list = useLoad(() => api().skills(), [rev]);
  if (list.loading && !list.data) return <Loading />;
  return (
    <>
      <ErrorLine error={list.error} />
      <div className="library-hint">Skills are reusable how-tos (a SKILL.md plus bundled files). Agents load them with <code>read</code>; a pin puts one into sessions.</div>
      {!list.data?.length ? <Empty>No skills yet. Agents write them with <code>write</code> type "skill".</Empty> : (
        <div className="doc-list">
          {list.data.map((k) => (
            <button key={k.id} className="doc-row skill-row" onClick={() => store.open({ kind: "library", docId: k.id })}>
              <div className="doc-row-title">{k.name}</div>
              <div className="skill-desc">{k.description}</div>
              <div className="doc-row-meta">
                <Pill tone={`state-${k.state}`}>{k.state}</Pill>
                {k.pins.map((p) => <Pill key={p.id} tone={p.suspended ? "bad" : p.mode === "always" ? "ok" : "info"} title={p.suspended ?? `pinned by ${p.pinnedByName}`}>{pinLabel(p)}</Pill>)}
                <span>{k.author} · {k.files.length} file{k.files.length === 1 ? "" : "s"} · {k.uses30d} use{k.uses30d === 1 ? "" : "s"} in 30d · {timeAgo(k.updatedAt)}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Under a skill doc: when to use it, its bundled files (raw links), its pins with remove, and a pin form. */
export function SkillDetails({ doc }: { doc: Doc }) {
  const buildings = useTown((s) => s.buildings);
  const me = useTown((s) => s.me);
  const [v, setV] = useState(0);
  const skill = useLoad(() => api().skill(doc.id), [doc.id, doc.updatedAt, v]);
  const [scope, setScope] = useState<SkillPinScope>("building");
  const [mode, setMode] = useState<SkillPinMode>("listed");
  const [buildingId, setBuildingId] = useState(doc.buildingId ?? buildings[0]?.id ?? "");
  const k: SkillView | null = skill.data;
  if (!k) return skill.loading ? <Loading /> : <ErrorLine error={skill.error} />;
  const canTown = !!me?.isAdmin;
  const canBuilding = store.can("building.manage", buildingId);
  const pin = async () => {
    await api().pinSkill(doc.id, { scope, mode, ...(scope === "building" ? { targetId: buildingId } : {}) });
    store.toast(`Pinned ${scope === "town" ? "town-wide" : "in the building"} (${mode})`, "ok");
    setV((n) => n + 1);
  };
  const unpin = (id: string) => async () => { await api().unpinSkill(id); store.toast("Unpinned", "ok"); setV((n) => n + 1); };
  return (
    <div className="skill-details">
      <div className="callout"><b>When to use:</b> {k.description}</div>
      <div className="muted">{k.uses7d} use{k.uses7d === 1 ? "" : "s"} in 7 days · {k.uses30d} in 30 days</div>
      <Section title={`Files (${k.files.length})`}>
        {!k.files.length ? <Empty>No bundled files.</Empty> : (
          <ul className="skill-files">
            {k.files.map((f) => <li key={f.path}><a href={`${API_BASE}/api/skills/${k.id}/files/${f.path}`} target="_blank" rel="noopener noreferrer">{f.path}</a> <span className="muted">{f.chars.toLocaleString()} chars</span></li>)}
          </ul>
        )}
      </Section>
      <Section title={`Pins (${k.pins.length})`}>
        {!k.pins.length ? <Empty>Not pinned: agents find it with <code>skills</code> or search.</Empty> : (
          <ul className="skill-pins">
            {k.pins.map((p) => (
              <li key={p.id}>
                <Pill tone={p.suspended ? "bad" : p.mode === "always" ? "ok" : "info"}>{pinLabel(p)}</Pill> <span className="muted">by {p.pinnedByName} · {timeAgo(p.createdAt)}</span>
                {p.suspended ? <div className="error-line">{p.suspended}</div> : null}
                {me ? <Act small tone="warn" run={unpin(p.id)}>Unpin</Act> : null}
              </li>
            ))}
          </ul>
        )}
        {canTown || canBuilding ? (
          <form className="skill-pin-form" onSubmit={(e) => e.preventDefault()}>
            <select value={scope} onChange={(e) => setScope(e.target.value as SkillPinScope)} aria-label="Scope">
              <option value="building">Building</option>
              {canTown ? <option value="town">Whole town</option> : null}
            </select>
            {scope === "building" ? (
              <select value={buildingId} onChange={(e) => setBuildingId(e.target.value)} aria-label="Building">
                {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            ) : null}
            <select value={mode} onChange={(e) => setMode(e.target.value as SkillPinMode)} aria-label="Mode">
              <option value="listed">Listed (name + when to use)</option>
              <option value="always">Always (full text in every prompt)</option>
            </select>
            <Act small tone="primary" run={pin}>Pin</Act>
          </form>
        ) : null}
      </Section>
    </div>
  );
}
