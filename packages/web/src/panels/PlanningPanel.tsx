/** Planning desk (Town Hall): create buildings, the whole-town resident roster (read-only; adding and dismissing live in each building's Members tab), roles, export. Donating and Bank shares live at the Bank. */
import { useMemo, useState } from "react";
import type { Building } from "@muster-town/schema";
import { api, tokenStore } from "../api";
import { store, useTown, roleOf } from "../state";
import { Glyph, PanelShell } from "./PanelShell";
import { RolesTab } from "./BuildingPanel";
import { Act, Empty, Field, Section, StatusPill } from "./ui";
import { portraitUrl } from "../map/sprites";
import { townPlan } from "../map/townPlan";

export function PlanningPanel({ tab }: { tab?: string }) {
  const me = useTown((s) => s.me);
  const tabs = ["Buildings", "Residents", "Roles", "System"];
  return (
    <PanelShell icon={<Glyph kind="planning" />} title="Planning desk" subtitle={me ? `Signed in as ${me.user.name}${me.isAdmin ? " · admin" : ""}` : "Read-only · sign in to plan"} tabs={tabs} initialTab={tab && tabs.includes(tab) ? tab : "Buildings"}>
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
      {can && !api().mock ? (
        <div className="walk-links">
          <button className="walk-link" onClick={() => townPlan.start()} title="Zoom out to the whole town: move, resize and draw buildings">
            <Glyph kind="planning" /><span>Plan the town on the map</span>
          </button>
        </div>
      ) : null}
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
            <div className="actions"><Act tone="primary" disabled={!name.trim()} run={async () => {
              const b = await api().createBuilding({ name: name.trim(), goal: goal.trim(), headcount, reviewPolicy: policy });
              setName(""); setGoal("");
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
  const byBuilding = useMemo(() => all.map((b) => ({ b, residents: Object.values(agents).filter((a) => a.kind === "resident" && a.homeBuildingId === b.id && a.status !== "retired").sort((x, y) => x.createdAt.localeCompare(y.createdAt)) })).filter((x) => x.residents.length || x.b.kind !== "town-hall"), [all, agents]);
  return (
    <>
      <p className="direction">Every resident in town. To add or dismiss residents, open a building's settings.</p>
      {byBuilding.map(({ b, residents }) => {
        const manage = b.kind !== "town-hall" && store.can("building.manage", b.id);
        return (
          <Section key={b.id} title={`${b.name} (${residents.length}${b.kind === "town-hall" ? "" : ` / ${b.headcount}`})`}>
            {!residents.length ? <Empty>No residents yet.</Empty> : residents.map((a) => (
              <button key={a.id} className="member" title={manage ? `Manage in ${b.name}'s members` : undefined} onClick={() => store.open(manage ? { kind: "building", id: b.id, tab: "Members" } : { kind: "agent", id: a.id })}>
                <img src={portraitUrl(a.sprite, 2)} alt="" />
                <div><b>{a.name}</b><span>{roleOf(a)}</span></div>
                <StatusPill status={a.status} />
              </button>
            ))}
            {manage ? (
              <div className="walk-links">
                <button className="walk-link" onClick={() => store.open({ kind: "building", id: b.id, tab: "Members" })}><Glyph kind="building" /><span>Add or dismiss in {b.name} members</span></button>
              </div>
            ) : null}
          </Section>
        );
      })}
    </>
  );
}

/** v1.3: "Pull main & redeploy" for holders of town.redeploy; the run's `system` events stream in below. */
function Redeploy() {
  const [image, setImage] = useState(false);
  const [since, setSince] = useState<number | null>(null);
  const events = useTown((s) => s.events);
  // the log of the run I started, else of the latest run (from its "requested" event)
  const from = useMemo(() => {
    if (since !== null) return since + 1;
    for (let i = events.length - 1; i >= 0; i--) {
      const p = events[i].payload as { redeploy?: boolean; phase?: string };
      if (events[i].type === "system" && p.redeploy && p.phase === "requested") return events[i].id;
    }
    return null;
  }, [events, since]);
  const lines = useMemo(() => from === null ? [] : events.filter((e) => e.type === "system" && e.id >= from && (e.payload as { redeploy?: boolean }).redeploy), [events, from]);
  return (
    <Section title="Redeploy">
      <p className="direction">Pull main on the host, reinstall if the lockfile changed, rebuild the web client, then restart the server. A dirty working tree aborts.</p>
      <label className="check"><input type="checkbox" checked={image} onChange={(e) => setImage(e.target.checked)} /> also rebuild desk image</label>
      <div className="actions"><Act tone="primary" run={async () => {
        const last = store.state.events.at(-1)?.id ?? 0;
        const r = await api().redeploy(image);
        setSince(last);
        store.toast(r.queued || r.running ? "A redeploy is already running; your request joins it" : "Redeploy started", r.queued || r.running ? "info" : "ok");
      }}>Pull main &amp; redeploy</Act></div>
      {lines.length ? (
        <ul className="redeploy-log">{lines.map((e) => <li key={e.id} title={typeof (e.payload as { output?: unknown }).output === "string" ? String((e.payload as { output: string }).output) : undefined}>{e.text}</li>)}</ul>
      ) : null}
    </Section>
  );
}

function System() {
  const [commit, setCommit] = useState<string | null>(null);
  const conn = useTown((s) => s.conn);
  useTown((s) => s.me);
  return (
    <>
      {store.can("town.redeploy") ? <Redeploy /> : null}
      <Section title="Git export">
        <p className="direction">Writes the town to a readable git mirror (buildings, docs, meetings, events) and commits if anything changed.</p>
        <div className="actions"><Act run={async () => { setCommit((await api().exportNow()) ?? "nothing to commit"); }}>Export now</Act>{commit ? <code>{commit}</code> : null}</div>
      </Section>
      <Section title="Session">
        <p className="direction">Connection: {conn}{api().mock ? " (mock server)" : ""}</p>
        <div className="actions"><button className="btn" onClick={() => { tokenStore.set(null); location.reload(); }}>Sign out</button></div>
      </Section>
    </>
  );
}
