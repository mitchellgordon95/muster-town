/** Planning desk (Town Hall): create buildings, add and dismiss residents, roles, export. Donations live at the donation box. */
import { useMemo, useState } from "react";
import { DAILY_TOKENS_PER_AGENT, type Building } from "@agent-town/schema";
import { api } from "../api";
import { store, useTown, roleOf } from "../state";
import { Glyph, PanelShell } from "./PanelShell";
import { RolesTab } from "./BuildingPanel";
import { DismissButton, canDismiss } from "./Dismiss";
import { Act, Empty, Field, Section, StatusPill } from "./ui";
import { PALETTES, portraitUrl } from "../map/sprites";

export function PlanningPanel({ tab }: { tab?: string }) {
  const me = useTown((s) => s.me);
  const tabs = ["Buildings", "Residents", "Roles", "System"];
  return (
    <PanelShell icon={<Glyph kind="planning" />} title="Planning desk" subtitle={me ? `Signed in as ${me.user.name}${me.isAdmin ? " · admin" : ""}` : ""} tabs={tabs} initialTab={tab && tabs.includes(tab) ? tab : "Buildings"}>
      {(t) => (
        <>
          {t === "Buildings" ? <Buildings /> : null}
          {t === "Residents" ? <Residents /> : null}
          {t === "Roles" ? <RolesTab /> : null}
          {t === "System" ? <System /> : null}
        </>
      )}
    </PanelShell>
  );
}

function Buildings() {
  const buildings = useTown((s) => s.buildings);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [headcount, setHeadcount] = useState(6);
  const [policy, setPolicy] = useState<Building["reviewPolicy"]>("human");
  const [perAgent, setPerAgent] = useState(DAILY_TOKENS_PER_AGENT);
  const [pool, setPool] = useState<number | null>(null);
  const can = store.can("town.manage_buildings");
  return (
    <>
      <Section title="Buildings">
        {buildings.map((b) => (
          <button key={b.id} className="doc-row" onClick={() => store.open({ kind: "building", id: b.id })}>
            <div className="doc-row-title">{b.name}</div>
            <div className="doc-row-meta"><span>{b.kind} · {b.headcount} desks · review {b.reviewPolicy}</span></div>
          </button>
        ))}
      </Section>
      {can ? (
        <Section title="New building">
          <form className="form" onSubmit={(e) => e.preventDefault()}>
            <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ocean Alkalinity Lab" /></Field>
            <Field label="Goal"><textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What should this building figure out?" /></Field>
            <div className="row2">
              <Field label="Desks"><input type="number" min={1} max={24} value={headcount} onChange={(e) => setHeadcount(+e.target.value)} /></Field>
              <Field label="Review policy">
                <select value={policy} onChange={(e) => setPolicy(e.target.value as Building["reviewPolicy"])}>
                  <option value="human">human</option><option value="reviewer">reviewer</option><option value="auto">auto</option>
                </select>
              </Field>
            </div>
            <div className="row2">
              <Field label="Max tokens / agent / day" hint="Ceiling for one resident"><input type="number" min={1} value={perAgent} onChange={(e) => setPerAgent(+e.target.value)} /></Field>
              <Field label="Daily pool (tokens)" hint="Residents draw from it as they work; empty = no limit"><input type="number" min={1} value={pool ?? ""} onChange={(e) => setPool(e.target.value ? +e.target.value : null)} /></Field>
            </div>
            <div className="actions"><Act tone="primary" disabled={!name.trim() || !(perAgent > 0)} run={async () => {
              const b = await api().createBuilding({ name: name.trim(), goal: goal.trim(), headcount, reviewPolicy: policy, dailyTokensPerAgent: perAgent, dailyTokens: pool });
              setName(""); setGoal(""); setPool(null);
              store.toast(`${b.name} is under construction`, "ok");
            }}>Create building</Act></div>
          </form>
        </Section>
      ) : <Empty>You need town.manage_buildings to create buildings.</Empty>}
    </>
  );
}

function Residents() {
  const all = useTown((s) => s.buildings);
  const agents = useTown((s) => s.agents);
  useTown((s) => s.me);
  const byBuilding = useMemo(() => all.map((b) => ({ b, residents: Object.values(agents).filter((a) => a.kind === "resident" && a.homeBuildingId === b.id).sort((x, y) => x.createdAt.localeCompare(y.createdAt)) })).filter((x) => x.residents.length), [all, agents]);
  return (
    <>
      {byBuilding.map(({ b, residents }) => (
        <Section key={b.id} title={`${b.name} (${residents.length}${b.kind === "town-hall" ? "" : ` / ${b.headcount}`})`}>
          {residents.map((a) => (
            <div key={a.id} className="resident-row">
              <button className="member" onClick={() => store.open({ kind: "agent", id: a.id })}>
                <img src={portraitUrl(a.sprite, 2)} alt="" />
                <div><b>{a.name}</b><span>{roleOf(a)}</span></div>
                <StatusPill status={a.status} />
              </button>
              {canDismiss(a) ? <DismissButton agent={a} small /> : null}
            </div>
          ))}
        </Section>
      ))}
      <NewResident />
    </>
  );
}

function NewResident() {
  const buildings = useTown((s) => s.buildings).filter((b) => b.kind !== "town-hall");
  const [buildingId, setBuildingId] = useState(buildings[0]?.id ?? "");
  const [name, setName] = useState("");
  const [sprite, setSprite] = useState(1);
  const can = store.can("building.manage", buildingId);
  return (
    <Section title="New resident">
      <form className="form" onSubmit={(e) => e.preventDefault()}>
        <Field label="Building">
          <select value={buildingId} onChange={(e) => setBuildingId(e.target.value)}>
            {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <Field label="Name" hint="Residents have no title or job description: they take whatever assignment they're given, end to end."><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lena" /></Field>
        <Field label="Look">
          <div className="sprites">
            {PALETTES.map((_, i) => i === 7 ? null : (
              <button type="button" key={i} className={i === sprite ? "on" : ""} onClick={() => setSprite(i)}><img src={portraitUrl(i, 2)} alt={`sprite ${i}`} /></button>
            ))}
          </div>
        </Field>
        <div className="actions">
          <Act tone="primary" disabled={!can || !name.trim() || !buildingId} title={can ? undefined : "Needs building.manage"} run={async () => {
            const a = await api().createResident({ buildingId, name: name.trim(), sprite });
            setName("");
            store.toast(`${a.name} moved in`, "ok", { kind: "agent", id: a.id });
          }}>Add resident</Act>
        </div>
      </form>
    </Section>
  );
}

function System() {
  const [commit, setCommit] = useState<string | null>(null);
  const conn = useTown((s) => s.conn);
  return (
    <>
      <Section title="Git export">
        <p className="direction">Writes the town to a readable git mirror (buildings, docs, meetings, events) and commits if anything changed.</p>
        <div className="actions"><Act run={async () => { setCommit((await api().exportNow()) ?? "nothing to commit"); }}>Export now</Act>{commit ? <code>{commit}</code> : null}</div>
      </Section>
      <Section title="Session">
        <p className="direction">Connection: {conn}{api().mock ? " (mock server)" : ""}</p>
        <div className="actions"><button className="btn" onClick={() => { localStorage.removeItem("agentTown.token"); location.reload(); }}>Sign out</button></div>
      </Section>
    </>
  );
}
