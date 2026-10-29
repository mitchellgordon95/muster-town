/** Planning desk (Town Hall): create buildings, the whole-town resident roster (read-only; adding and dismissing live in each building's Members tab), roles, secrets (admins: the collective's secrets and grants, docs/secrets.md), export. Donating and Bank pools live at the Bank. */
import { isFork } from "../forks";
import { useMemo, useState } from "react";
import { api, API_BASE, tokenStore } from "../api";
import { store, useTown, roleOf } from "../state";
import { Glyph, PanelShell } from "./PanelShell";
import { RolesTab } from "./BuildingPanel";
import { SecretsTab } from "./Secrets";
import { Act, Empty, Field, NumberInput, Section, StatusPill } from "./ui";
import { portraitUrl } from "../map/sprites";

export function PlanningPanel({ tab }: { tab?: string }) {
  const me = useTown((s) => s.me);
  const tabs = ["Buildings", "Residents", "Roles", ...(me?.isAdmin ? ["Secrets"] : []), "System"];
  return (
    <PanelShell icon={<Glyph kind="planning" />} title="Planning desk" subtitle={me ? `Signed in as ${me.user.name}${me.isAdmin ? " · admin" : ""}` : "Read-only · sign in to plan"} tabs={tabs} initialTab={tab && tabs.includes(tab) ? tab : "Buildings"}>
      {(t) => (
        <>
          {t === "Buildings" ? <Buildings /> : null}
          {t === "Residents" ? <Residents /> : null}
          {t === "Roles" ? <RolesTab /> : null}
          {t === "Secrets" ? <SecretsTab /> : null}
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
  const can = store.can("town.manage_buildings");
  return (
    <>
      <p className="direction">To move, resize or draw buildings, use the town map table in the Town Hall (walk up and press E, or click it).</p>
      <Section title="Buildings">
        {buildings.map((b) => (
          <button key={b.id} className="doc-row" onClick={() => store.open({ kind: "building", id: b.id })}>
            <div className="doc-row-title">{b.name}</div>
            <div className="doc-row-meta"><span>{b.kind} · {b.headcount} desks</span></div>
          </button>
        ))}
      </Section>
      {can ? (
        <Section title="New building">
          <form className="form" onSubmit={(e) => e.preventDefault()}>
            <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ocean Alkalinity Lab" /></Field>
            <Field label="Goal"><textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What should this building figure out?" /></Field>
            <Field label="Desks" hint="Code access is on when the collective has a repo; residents push code only if the host has Docker and a Claude token in the collective's .env (README, Run it)."><NumberInput min={1} max={24} value={headcount} onChange={setHeadcount} /></Field>
            <div className="actions"><Act tone="primary" disabled={!name.trim()} run={async () => {
              const b = await api().createBuilding({ name: name.trim(), goal: goal.trim(), headcount });
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
  const byBuilding = useMemo(() => all.map((b) => ({ b, residents: Object.values(agents).filter((a) => a.kind === "resident" && !isFork(a) && a.homeBuildingId === b.id && a.status !== "retired").sort((x, y) => x.createdAt.localeCompare(y.createdAt)) })).filter((x) => x.residents.length || x.b.kind !== "town-hall"), [all, agents]);
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

/** Session slots: how many work sessions the town runs at once (desks.maxRunning, default 30). */
function Slots() {
  const slots = useTown((s) => s.health?.slots ?? null);
  const admin = useTown((s) => !!s.me?.isAdmin);
  const [max, setMax] = useState<string>("");
  if (!slots) return null;
  const full = slots.running >= slots.max;
  return (
    <Section title="Session slots">
      <p className="direction">
        <b>{slots.running} of {slots.max}</b> work sessions running{full ? "; queued work is waiting for a free slot" : ""}.
      </p>
      {admin ? (
        <div className="actions">
          <input type="number" min={1} max={1000} value={max} placeholder={String(slots.max)} onChange={(e) => setMax(e.target.value)} aria-label="Max running sessions" style={{ width: 90 }} />
          <Act disabled={!max || Number(max) < 1} run={async () => { const r = await api().setMaxRunning(Number(max)); store.toast(`Session slots set to ${r.desks.maxRunning}`, "ok"); setMax(""); }}>Set cap</Act>
        </div>
      ) : null}
    </Section>
  );
}

/**
 * A hosted collective (served at `/<slug>/`): its key state for everyone, and for its admins the way to add one (the
 * Bank) and to retire the collective (its address shows a retired notice and is never given out again).
 */
function ThisCollective() {
  const funding = useTown((s) => s.health?.funding);
  const me = useTown((s) => s.me);
  const [sure, setSure] = useState(false);
  const admin = !!me?.isAdmin;
  return (
    <Section title="This collective">
      <p className="direction">
        {funding === "api-key" ? "Runs on its own Anthropic API key (at the Bank)." : "No key yet: its agents are held until an admin adds an Anthropic API key at the Bank."}
        {" "}Muster Town never spends its own credentials here.
      </p>
      {admin ? (
        <div className="actions">
          <button className="btn" onClick={() => { if (!store.walkTo("bank", { kind: "bank" })) store.open({ kind: "bank" }); }}>Open the Bank</button>
          {sure
            ? <><Act tone="bad" run={async () => { await api().retireCollective(); location.assign("/"); }}>Retire it for good</Act><button className="btn" onClick={() => setSure(false)}>Keep it</button></>
            : <button className="btn" onClick={() => setSure(true)}>Retire this collective…</button>}
        </div>
      ) : null}
      {admin && sure ? <p className="direction">Retiring stops everything here at once; {location.host}{API_BASE}/ shows a retired notice and the address is never reused.</p> : null}
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
      {API_BASE ? <ThisCollective /> : null}
      <Slots />
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
