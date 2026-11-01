/** Building panel (E at the door): overview, goals, grants and schedule (labs; GoalsTab.tsx), settings (managers: name, the goal it is attached to, desks, manager; 1:1 mt_n25udpflus decision 3: a building is a thin layer on the goal tree). No Members tab (flag dc_v7ejy1j5ri): roles live on the planning desk; live forks show on the map. Board, filing cabinet and in-tray are places; the collective's secrets are a planning-desk tab. */
import { isFork } from "../forks";
import { useMemo, useState, type ReactNode } from "react";
import { BuildingDefaults, MAX_HEADCOUNT, ROOT_GOAL_ID, type Schedule, type SnapshotBuilding, type Workspace } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { Glyph, PanelShell } from "./PanelShell";
import { QueueTab } from "./QueueTab";
import { Meter } from "./AgentPanel";
import { Act, Empty, Field, KV, NumberInput, Pill, Section, fmtTokens, usd, useLoad } from "./ui";
import { repeatLabel, runsAtLabel } from "../format";
import { layoutEdit } from "../map/layoutEdit";
import { canOneOnOne, canTalkToManager, openOneOnOne, openPlanner } from "./oneOnOne";
import { UNBLOCK_LINE, blockedLabel } from "./keyResults";
import { GoalTabsSummary, GoalsTab, GrantsTab } from "./GoalsTab";
import { GoalPicker, goalPath, useGoalTree } from "./GoalPicker";
import { findGoal } from "./goalTree";
import { purposeOf } from "../purpose";
import { IdLink } from "./Markdown";

/** "Captain: <captain>" (docs/goals.md "Captains on nodes"): the attachment's effective owner, once; the goal card above already says the goal, so only a link to it in the Town Hall goal tree follows. */
function GoalOwner({ b }: { b: SnapshotBuilding }) {
  const root = useGoalTree();
  if (!root) return null;
  const goalId = b.goalId ?? ROOT_GOAL_ID;
  const node = findGoal(root, goalId);
  if (!node) return null;
  return (
    <div className="muted goal-meta">Captain: <b>{node.owner.name}</b> · <button className="link" title={goalPath(root, goalId)} onClick={() => store.open({ kind: "goals", id: goalId })}>in the goal tree →</button></div>
  );
}

export function BuildingPanel({ id, tab }: { id: string; tab?: string }) {
  const b = useTown((s) => s.buildings.find((x) => x.id === id));
  useTown((s) => s.me); // re-render when my permissions change (store.can below)
  if (!b) return <PanelShell title="Unknown building"><Empty>No building with id {id}.</Empty></PanelShell>;
  const lab = b.kind !== "town-hall";
  const tabs = ["Overview", ...(lab ? ["Goals", "Grants", "Queue", "Schedule"] : []), ...(store.can("building.manage", id) ? ["Settings"] : [])];
  return (
    <PanelShell icon={<Glyph kind="building" />} title={b.name} subtitle={b.kind === "town-hall" ? "Town Hall" : "Lab"} tabs={tabs} initialTab={tab && tabs.includes(tab) ? tab : "Overview"}>
      {(t) => (
        <>
          {t === "Overview" ? <Overview b={b} /> : null}
          {t === "Goals" ? <GoalsTab b={b} /> : null}
          {t === "Grants" ? <GrantsTab b={b} /> : null}
          {t === "Queue" ? <QueueTab buildingId={b.id} /> : null}
          {t === "Schedule" ? <ScheduledList b={b} /> : null}
          {t === "Settings" ? <Settings b={b} /> : null}
        </>
      )}
    </PanelShell>
  );
}

/** Walk the avatar to a place and open its panel; falls back to just opening the panel. */
function walk(placeId: string, panel: Parameters<typeof store.open>[0]) {
  if (!store.walkTo(placeId, panel ?? undefined)) store.open(panel);
}

/** "owner/repo" for a GitHub remote, else the URL or path. */
function repoLabel(ws: Workspace): string {
  return ws.repoUrl ? ws.repoUrl.replace(/^(?:https:\/\/|ssh:\/\/)?(?:git@)?github\.com[:/]/, "").replace(/\.git$/, "") : ws.path;
}

function Overview({ b }: { b: SnapshotBuilding }) {
  const agents = useTown((s) => s.agents);
  const repo = useTown((s) => s.town?.workspace);
  const members = useMemo(() => Object.values(agents).filter((a) => (a.homeBuildingId ?? a.buildingId) === b.id && a.kind === "resident"), [agents, b.id]);
  const budget = useLoad(() => api().budget(), [b.id]);
  const row = budget.data?.buildings.find((x) => x.buildingId === b.id);
  // the WS resends a building after funded charges only, so the copy fetched on open can be the fresher one
  const live = b.budget, usage = row?.tokensAllTime !== undefined && row.tokensAllTime > (live?.tokensAllTime ?? -1)
    ? { today: row.tokensToday ?? 0, allTime: row.tokensAllTime } : live ? { today: live.tokensToday ?? 0, allTime: live.tokensAllTime ?? 0 } : null;
  const places = useTown((s) => s.places);
  const hasBoard = places.some((p) => p.id === `board:${b.id}`);
  const hasCabinet = places.some((p) => p.id === `cabinet:${b.id}`);
  const hasTray = places.some((p) => p.id === `intray:${b.id}`);
  const hasRoom = places.some((p) => p.id === `meeting-room:${b.id}`);
  const purpose = purposeOf(b, places);
  return (
    <>
      {purpose ? <div className="goal-card"><span>Goal</span>{purpose}</div> : null}
      {blockedLabel(b) ? (
        <div className="kr-blocked"><Pill tone="bad">{blockedLabel(b)}</Pill> {UNBLOCK_LINE}
          {store.can("building.manage", b.id) ? <> <button className="link" onClick={() => store.open({ kind: "building", id: b.id, tab: "Goals" })}>Write them in Goals →</button></> : null}
        </div>
      ) : null}
      {b.kind !== "town-hall" ? <GoalOwner b={b} /> : null}
      {b.kind !== "town-hall" ? <GoalTabsSummary b={b} /> : null}
      {hasBoard || hasTray || hasRoom ? (
        <div className="walk-links">
          {hasBoard ? <button className="walk-link" onClick={() => walk(`board:${b.id}`, { kind: "board", id: b.id })}><Glyph kind="board" /><span>Walk to the board</span></button> : null}
          {hasCabinet ? <button className="walk-link" onClick={() => walk(`cabinet:${b.id}`, { kind: "cabinet", id: b.id })}><Glyph kind="cabinet" /><span>Walk to the filing cabinet</span></button> : null}
          {hasTray ? (
            <button className="walk-link" onClick={() => walk(`intray:${b.id}`, { kind: "intray", id: b.id })}>
              <Glyph kind="intray" /><span>Walk to the in-tray</span>{b.intray ? <Pill tone="warn">{b.intray} waiting</Pill> : null}
            </button>
          ) : null}
          {hasRoom ? <button className="walk-link" onClick={() => walk(`meeting-room:${b.id}`, { kind: "meeting", id: `room:${b.id}` })}><Glyph kind="meeting" /><span>Walk to the meeting table</span></button> : null}
        </div>
      ) : null}
      {b.kind !== "town-hall" && b.managerAgentId && agents[b.managerAgentId] && canTalkToManager(b.id) ? (
        <div className="actions"><Act tone="primary" run={() => openOneOnOne(b.id)}>Talk to ★ {agents[b.managerAgentId].name}</Act></div>
      ) : null}
      {b.kind === "town-hall" && b.managerAgentId && agents[b.managerAgentId] && (store.can("goals.edit") || canOneOnOne(b.id)) ? (
        <div className="actions"><Act tone="primary" run={() => openPlanner()}>Talk to ★ {agents[b.managerAgentId].name}</Act></div>
      ) : null}
      {store.can("building.manage", b.id) && !api().mock ? (
        <div className="walk-links">
          <button className="walk-link" onClick={() => layoutEdit.start(b.id).catch((e) => store.toast((e as Error).message, "bad"))}>
            <Glyph kind="building" /><span>Edit layout</span>
          </button>
        </div>
      ) : null}
      <KV items={[
        ["Adj. tokens used", usage ? <><b>{fmtTokens(usage.today)}</b> today · <b>{fmtTokens(usage.allTime)}</b> all-time</> : budget.loading ? "…" : "—"],
        ...(b.kind !== "town-hall" ? [
          ["Budget", live && live.bankTokens > 0 ? <>{fmtTokens(live.remainingTokens)} left to draw from the Bank</>
            : row && row.allocated > 0 ? <>{fmtTokens(row.allocated - row.spent)} left of {fmtTokens(row.allocated)} <Meter v={row.spent / row.allocated} /></>
            : budget.loading ? "…" : "nothing to draw"],
          ["Spent", row?.spentUsd !== undefined ? usd(row.spentUsd) : "—"],
          ["Collective defaults", defaultsLine(b, repo)],
          ["Desks", `${members.length} / ${b.headcount}`],
          ["In-tray", b.managerAgentId ? `worked by ★ ${agents[b.managerAgentId]?.name ?? "the manager agent"}` : "worked by you (no manager agent)"],
        ] : [
          ["Manager", b.managerAgentId && agents[b.managerAgentId] ? <>★ {agents[b.managerAgentId].name}: the planning agent. It answers 1:1s and facilitates reorg meetings; the in-tray is the humans'.</> : "the Planner, once someone plans with it"],
        ]) as [string, ReactNode][],
      ]} />
    </>
  );
}

/** The collective defaults as this building runs them (read-only here; an admin sets them in the Town Hall's Settings). */
function defaultsLine(b: SnapshotBuilding, repo: Workspace | undefined): ReactNode {
  return <span title="Set for every building at once in the Town Hall's Settings (admins)">
    {b.model} · cheap: {b.cheapModel} · {b.maxTurnsPerSession} turns{b.codeAccess && repo ? <> · code on <code>{repoLabel(repo)}</code></> : " · no code access"}
  </span>;
}

/** What a fire creates, in words: its lane and who takes it ("exploration · the building queue (a fork runs it)"). */
function createsLabel(x: Schedule, b: SnapshotBuilding): ReactNode {
  const lane = x.lane === "grant" ? <>grant {x.grantId ? <IdLink id={x.grantId} /> : null}</> : x.lane === "exploration" ? <>exploration{x.keyResultId ? <> <IdLink id={x.keyResultId} /></> : null}</> : "directed";
  return <>{lane} · {b.managerAgentId ? "the building queue (a fork runs it)" : "nobody (no manager agent)"}</>;
}

/** The building's Schedule tab (GET /api/scheduled): timed jobs that live on the building; each run goes to whoever is around. The schedule board on the map opens it. */
function ScheduledList({ b }: { b: SnapshotBuilding }) {
  const all = useTown((s) => s.scheduled);
  const assignments = useTown((s) => s.assignments);
  useTown((s) => s.me);
  const rows = useMemo(() => all.filter((x) => x.buildingId === b.id), [all, b.id]);
  if (b.kind === "town-hall") return null;
  const canCancel = store.can("building.assign", b.id);
  return (
    <Section title={<>Schedule {rows.length ? <Pill tone="scheduled">{rows.length}</Pill> : null}</>}>
      {!rows.length ? <Empty>Nothing scheduled. A manager adds a timed job with the <code>schedule</code> tool; each run goes to whoever is around.</Empty> : (
        <div className="doc-list">{rows.map((x) => {
          const last = x.lastAssignmentId ? assignments[x.lastAssignmentId] : undefined;
          const swap = (y: Schedule) => store.set({ scheduled: store.state.scheduled.map((z) => z.id === y.id ? y : z) });
          return (
            <div key={x.id} className="doc-row" title={x.description}>
              <b>{x.title}</b> {x.paused ? <Pill tone="warn">paused</Pill> : null}
              <div className="doc-row-meta">
                <span>next {x.paused ? "— (paused)" : x.nextRunAt ? runsAtLabel(x.nextRunAt) : "—"}</span>
                <span>{repeatLabel(x)}{x.endsAt ? ` until ${x.endsAt.slice(0, 10)}` : ""}{x.runs ? ` · ran ${x.runs}×` : ""}</span>
              </div>
              {x.lastAssignmentId ? <div className="doc-row-meta"><span>last fired: {last ? `"${last.title}" (${last.status === "pending" ? "queued" : last.status === "active" ? "running" : last.status})` : x.lastAssignmentId}{x.lastRunAt ? ` · ${runsAtLabel(x.lastRunAt)}` : ""}</span></div> : null}
              <div className="doc-row-meta">
                <span>creates: {createsLabel(x, b)}</span>
                {canCancel ? <span>
                  <Act small run={async () => swap(await api().editSchedule(x.id, { paused: !x.paused }))}>{x.paused ? "Resume" : "Pause"}</Act>{" "}
                  <Act small run={async () => { await api().cancelSchedule(x.id); store.set({ scheduled: store.state.scheduled.filter((y) => y.id !== x.id) }); }}>Cancel</Act>
                </span> : null}
              </div>
            </div>
          );
        })}</div>
      )}
    </Section>
  );
}

export function Settings({ b }: { b: SnapshotBuilding }) {
  const [f, setF] = useState({ name: b.name, managerAgentId: b.managerAgentId });
  // Desks sets the building's size on the map (drawn from the goal tree) and its daily cap: town.manage_buildings
  const [desks, setDesks] = useState(b.headcount);
  const canDesks = b.kind === "lab" && store.can("town.manage_buildings");
  // the goal it is attached to: goals.edit (admins, or the goal's owner) on both ends; never unset
  const root = useGoalTree();
  const [goalId, setGoalId] = useState(b.goalId ?? ROOT_GOAL_ID);
  const canAttach = b.kind === "lab" && store.can("goals.edit");
  const agents = useTown((s) => s.agents);
  const admin = useTown((s) => !!s.me?.isAdmin);
  const named = useMemo(() => Object.values(agents).filter((a) => a.kind === "resident" && !isFork(a) && a.homeBuildingId === b.id).sort((x, y) => x.name.localeCompare(y.name)), [agents, b.id]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  return (<>
    <Section title="Building">
    <form className="form" onSubmit={(e) => e.preventDefault()}>
      <Field label="Name" hint="Optional. Leave it blank and the building is named after its goal's short text (again on every save left blank); a name you type stays.">
        <input value={f.name} maxLength={80} placeholder="defaults to the goal's short text" onChange={(e) => set("name", e.target.value)} />
      </Field>
      {b.kind !== "town-hall" ? (
        <Field label="Attached to" hint={`${goalPath(root, goalId)}. The goal is the building's purpose: it stands at that goal's plaza on the map, and its work (grants, exploration) names open key results in that goal's subtree.${canAttach ? "" : " Changing it takes goals.edit on both goals (an admin or the goal's captain)."}`}>
          <GoalPicker value={goalId} onChange={setGoalId} disabled={!canAttach} />
        </Field>
      ) : null}
      <Field label="Desks" hint={`The building's size on the map follows its desks (the map is drawn from the goal tree; a full lab adds one when a fork needs it). This also sets the daily cap (the collective's daily budget / agent × desks).${canDesks ? "" : " Changing it takes town.manage_buildings."}`}>
        {canDesks
          ? <span><input type="number" min={1} max={MAX_HEADCOUNT} value={desks} onChange={(e) => setDesks(Math.max(1, Math.min(MAX_HEADCOUNT, Math.floor(Number(e.target.value)) || 1)))} /> {b.lot ? `${b.lot.w}×${b.lot.h} now` : ""}</span>
          : <span>{b.lot ? `${b.lot.w}×${b.lot.h} · ` : ""}{b.headcount} desk{b.headcount === 1 ? "" : "s"}</span>}
      </Field>
      {b.kind !== "town-hall" ? <Field label="Manager" hint="Every building made at the planning desk gets its manager when it is built: one named agent at a desk. It works the in-tray (its forks' reports), facilitates meetings and wears the ★ badge; queued work runs on its forks; its rollups go to the Town Hall in-tray. None: you work the in-tray.">
        <select value={f.managerAgentId ?? ""} onChange={(e) => set("managerAgentId", e.target.value || null)}>
          <option value="">none</option>
          {named.map((a) => <option key={a.id} value={a.id} disabled={a.status === "stopped" || a.status === "banned"}>{a.name}{a.status === "stopped" || a.status === "banned" ? ` (${a.status})` : ""}</option>)}
        </select>
      </Field> : null}
      <div className="actions"><Act tone="primary" run={async () => {
        const { name, ...rest } = f;
        const next = await api().updateBuilding(b.id, {
          ...rest,
          ...(name.trim() !== b.name ? { name: name.trim() } : {}),
          ...(canAttach && goalId !== (b.goalId ?? ROOT_GOAL_ID) ? { goalId } : {}),
          ...(canDesks && desks !== b.headcount ? { headcount: desks } : {}),
        });
        set("name", next.name);
        store.toast("Settings saved", "ok");
      }}>Save settings</Act></div>
    </form>
    </Section>
    {b.kind === "town-hall" && admin ? <CollectiveDefaults /> : null}
  </>);
}

/**
 * The collective defaults (1:1 mt_n25udpflus decision 3): model, cheap model, max turns and code
 * access for every building at once (PUT /api/town/defaults, admins). Saving writes them through to every lab.
 */
function CollectiveDefaults() {
  const town = useTown((s) => s.town);
  const buildings = useTown((s) => s.buildings);
  const labs = useMemo(() => buildings.filter((x) => x.kind === "lab"), [buildings]);
  const repo = town?.workspace;
  const d = BuildingDefaults.parse({ codeAccess: !!repo, ...town?.defaults });
  const [f, setF] = useState({ model: d.model, cheapModel: d.cheapModel, maxTurnsPerSession: d.maxTurnsPerSession, codeAccess: d.codeAccess });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const next = f;
  const differ = labs.filter((x) => (Object.keys(next) as (keyof typeof next)[]).some((k) => x[k] !== next[k]));
  return (
    <Section title="Collective defaults">
      <form className="form" onSubmit={(e) => e.preventDefault()}>
        <p className="direction">Every building runs on these. Saving applies them to every building at once; desks are the only setting a building keeps for itself.</p>
        <div className="row2">
          <Field label="Model"><input value={f.model} onChange={(e) => set("model", e.target.value)} /></Field>
          <Field label="Cheap model" hint="Proxy chat"><input value={f.cheapModel} onChange={(e) => set("cheapModel", e.target.value)} /></Field>
        </div>
        <div className="row2">
          <Field label="Max turns / session" hint="Safety rail"><NumberInput min={1} value={f.maxTurnsPerSession} onChange={(n) => set("maxTurnsPerSession", n)} /></Field>
        </div>
        <Field label="Code access" hint={repo
          ? "Managers and their forks work on the collective's repo, each on its own branch. Needs Docker and a Claude token in the collective's .env on the host (README, Run it)."
          : "This collective has no repo yet (collective.json `workspace`), so there is nothing to give code access to."}>
          <span className="check"><input type="checkbox" checked={f.codeAccess} disabled={!repo && !f.codeAccess} onChange={(e) => set("codeAccess", e.target.checked)} /> {repo ? <>Work on <code>{repoLabel(repo)}</code></> : "No collective repo"}</span>
        </Field>
        {differ.length ? <p className="direction">Saving changes {differ.map((x) => x.name).join(", ")} (they run on other values now).</p> : null}
        <div className="actions"><Act tone="primary" disabled={!f.model.trim() || !f.cheapModel.trim()} run={async () => {
          const r = await api().setTownDefaults(next);
          if (town) store.set({ town: { ...town, defaults: r.defaults } });
          store.toast(`Collective defaults saved for ${r.buildings.length} building${r.buildings.length === 1 ? "" : "s"}`, "ok");
        }}>Save for every building</Act></div>
      </form>
    </Section>
  );
}
