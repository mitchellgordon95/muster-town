/** Building panel (E at the door): overview, members + roles, meetings, settings (managers: building fields). Members lists residents (managers add and dismiss there) and roles. Board, filing cabinet and in-tray are places; the collective's secrets are a planning-desk tab. */
import { isFork } from "../forks";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_POOL_ID, MAX_KEY_RESULTS_PER_OBJECTIVE, MAX_OBJECTIVES, type KeyResultStatus, type KpiKey, type Meeting, type SnapshotBuilding, type Workspace } from "@muster-town/schema";
import { fmtPct, poolColor } from "../pools";
import { api, type GoalKeyResult, type ObjectiveView } from "../api";
import { store, useTown, roleOf } from "../state";
import { Glyph, PanelShell } from "./PanelShell";
import { Meter } from "./AgentPanel";
import { DismissButton, canDismiss } from "./Dismiss";
import { ADJ, Act, Empty, ErrorLine, Field, KV, Loading, MTokensInput, NumberInput, Pill, Section, StatusPill, fmtTokens, nameOf, timeAgo, usd, useLoad } from "./ui";
import { fromMillions, toMillions } from "../format";
import { PALETTES, portraitUrl } from "../map/sprites";
import { AttendeePicker, useAttendees } from "./AttendeePicker";
import { attendeeInput } from "./attendees";
import { layoutEdit } from "../map/layoutEdit";
import { canOneOnOne, openOneOnOne } from "./oneOnOne";
import { UNBLOCK_LINE, blockedLabel, krAuthorLine, krStatusLabel, krTone, objectiveLine, settableStatuses } from "./keyResults";
import { openDocLink } from "./Markdown";

export function BuildingPanel({ id, tab }: { id: string; tab?: string }) {
  const b = useTown((s) => s.buildings.find((x) => x.id === id));
  useTown((s) => s.me); // re-render when my permissions change (store.can below)
  if (!b) return <PanelShell title="Unknown building"><Empty>No building with id {id}.</Empty></PanelShell>;
  const tabs = ["Overview", "Members", "Meetings", ...(store.can("building.manage", id) ? ["Settings"] : [])];
  return (
    <PanelShell icon={<Glyph kind="building" />} title={b.name} subtitle={b.kind === "town-hall" ? "Town Hall" : "Lab"} tabs={tabs} initialTab={tab && tabs.includes(tab) ? tab : "Overview"}>
      {(t) => (
        <>
          {t === "Overview" ? <Overview b={b} /> : null}
          {t === "Members" ? <Members b={b} /> : null}
          {t === "Meetings" ? <MeetingsTab b={b} /> : null}
          {t === "Settings" ? <Settings b={b} /> : null}
        </>
      )}
    </PanelShell>
  );
}

/** Walk the avatar to a place and open its panel; falls back to just opening the panel. */
export function walk(placeId: string, panel: Parameters<typeof store.open>[0]) {
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
  return (
    <>
      {b.goal ? <div className="goal-card"><span>Goal</span>{b.goal}</div> : null}
      {b.description ? <p className="direction">{b.description}</p> : null}
      {blockedLabel(b) ? (
        <div className="kr-blocked"><Pill tone="bad">{blockedLabel(b)}</Pill> {UNBLOCK_LINE}
          {store.can("building.manage", b.id) ? <> <button className="link" onClick={() => store.open({ kind: "building", id: b.id, tab: "Settings" })}>Write them in Settings →</button></> : null}
        </div>
      ) : null}
      {hasBoard || hasTray ? (
        <div className="walk-links">
          {hasBoard ? <button className="walk-link" onClick={() => walk(`board:${b.id}`, { kind: "board", id: b.id })}><Glyph kind="board" /><span>Walk to the board</span></button> : null}
          {hasCabinet ? <button className="walk-link" onClick={() => walk(`cabinet:${b.id}`, { kind: "cabinet", id: b.id })}><Glyph kind="cabinet" /><span>Walk to the filing cabinet</span></button> : null}
          {hasTray ? (
            <button className="walk-link" onClick={() => walk(`intray:${b.id}`, { kind: "intray", id: b.id })}>
              <Glyph kind="intray" /><span>Walk to the in-tray</span>{b.intray ? <Pill tone="warn">{b.intray} waiting</Pill> : null}
            </button>
          ) : null}
        </div>
      ) : null}
      {b.kind !== "town-hall" && b.managerAgentId && agents[b.managerAgentId] && canOneOnOne(b.id) ? (
        <div className="actions"><Act tone="primary" run={() => openOneOnOne(b.id)}>Talk to ★ {agents[b.managerAgentId].name}</Act></div>
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
          ["Models", `${b.model} · cheap: ${b.cheapModel}`],
          ["Daily / agent", `${fmtTokens(b.dailyTokensPerAgent)} ${ADJ}`],
          ["Desks", `${members.length} / ${b.headcount}`],
          ["In-tray", b.managerAgentId ? `worked by ★ ${agents[b.managerAgentId]?.name ?? "the manager agent"}` : "worked by you (no manager agent)"],
          ...(b.codeAccess && repo ? [["Code", <>the collective repo <code>{repoLabel(repo)}</code></>] as [string, ReactNode]] : []),
        ] : []) as [string, ReactNode][],
      ]} />
    </>
  );
}

function Members({ b }: { b: SnapshotBuilding }) {
  const agents = useTown((s) => s.agents);
  useTown((s) => s.me);
  const members = useMemo(() => Object.values(agents).filter((a) => (a.homeBuildingId ?? a.buildingId) === b.id && a.kind !== "human" && a.status !== "retired").sort((x, y) => x.name.localeCompare(y.name)), [agents, b.id]);
  const residents = members.filter((a) => a.kind === "resident" && !isFork(a)).length;
  const forks = members.filter(isFork).length;
  const manage = store.can("building.manage", b.id);
  return (
    <>
      <Section title={`Residents (${residents} / ${b.headcount})${forks ? ` + ${forks} fork${forks === 1 ? "" : "s"}` : ""}`}>
        {!members.length ? <Empty>{manage ? "No one works here yet. Add a resident below." : "No one works here yet."}</Empty> : (
          <div className="members">
            {members.map((a) => (
              <div key={a.id} className="member-row">
                <button className="member" onClick={() => store.open({ kind: "agent", id: a.id })}>
                  <img src={portraitUrl(a.sprite, 2)} alt="" />
                  <div><b>{a.name}</b><span>{roleOf(a)}</span></div>
                  <StatusPill status={a.status} />
                </button>
                {canDismiss(a) ? <DismissButton agent={a} small /> : null}
              </div>
            ))}
          </div>
        )}
      </Section>
      {manage ? <NewResident buildingId={b.id} /> : null}
      <RolesTab buildingId={b.id} />
    </>
  );
}

export function phaseTone(p: Meeting["phase"]) { return p === "collecting" ? "warn" : p === "discussing" ? "ok" : p === "done" ? "" : p === "cancelled" ? "bad" : "info"; }

function MeetingsTab({ b }: { b: SnapshotBuilding }) {
  const all = useTown((s) => s.meetings);
  const list = useMemo(() => Object.values(all).filter((m) => m.buildingId === b.id || (b.kind === "town-hall" && m.buildingId === null)).sort((x, y) => y.createdAt.localeCompare(x.createdAt)), [all, b]);
  const can = store.can("meeting.facilitate", b.id) || store.can("building.manage", b.id);
  const [kind, setKind] = useState<Exclude<Meeting["kind"], "one-on-one">>(b.kind === "town-hall" ? "town-hall" : "standup");
  const invite = useAttendees(b);
  return (
    <>
      {can ? (<>
        <div className="inline-form">
          <select value={kind} onChange={(e) => setKind(e.target.value as Exclude<Meeting["kind"], "one-on-one">)}>
            {(["standup", "retro", "planning", "town-hall"] as const).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <Act tone="primary" run={async () => {
            const m = await api().createMeeting({ kind, buildingId: b.kind === "town-hall" ? null : b.id, startNow: true, ...attendeeInput(invite.picked) });
            store.putMeeting(m); store.open({ kind: "meeting", id: m.id });
          }}>Call meeting</Act>
        </div>
        <AttendeePicker state={invite} />
      </>) : null}
      {!list.length ? <Empty>No meetings yet.</Empty> : list.map((m) => (
        <button key={m.id} className="doc-row" onClick={() => store.open({ kind: "meeting", id: m.id })}>
          <div className="doc-row-title">{m.title}</div>
          <div className="doc-row-meta"><Pill tone={phaseTone(m.phase)}>{m.phase}</Pill><span>{m.kind} · {m.attendeeIds.length} attendees · {timeAgo(m.createdAt)}</span></div>
        </button>
      ))}
    </>
  );
}

export function RolesTab({ buildingId }: { buildingId?: string }) {
  const r = useLoad(() => api().roles(buildingId), [buildingId]);
  const canManage = buildingId ? store.can("building.manage", buildingId) : store.can("town.manage_roles");
  if (r.loading && !r.data) return <Loading />;
  const roles = (r.data?.roles ?? []).filter((x) => (buildingId ? x.buildingId === buildingId : true));
  return (
    <>
      <ErrorLine error={r.error} />
      {roles.map((role) => {
        const holders = (r.data?.memberships ?? []).filter((m) => m.roleId === role.id);
        return (
          <Section key={role.id} title={<>{role.name} <Pill tone="type">{role.scope}</Pill></>}>
            <div className="holders">
              {holders.length ? holders.map((h) => (
                <span key={h.holderId} className="holder">
                  {nameOf(h.holderId)}{h.holderKind === "user" ? " (human)" : ""}
                  {canManage ? <button className="x" title="Remove role" onClick={async () => { try { await api().unassignRole(h); r.reload(); } catch (e) { store.toast((e as Error).message, "bad"); } }}>×</button> : null}
                </span>
              )) : <span className="muted">nobody</span>}
            </div>
            <div className="perms">{role.permissions.map((p) => <code key={p}>{p}</code>)}</div>
            {canManage ? <AddHolder onAdd={async (holderKind, holderId) => { await api().assignRole({ roleId: role.id, holderKind, holderId }); r.reload(); }} /> : null}
          </Section>
        );
      })}
    </>
  );
}

function AddHolder({ onAdd }: { onAdd: (kind: "agent" | "user", id: string) => Promise<void> }) {
  const agents = useTown((s) => s.agents);
  const [v, setV] = useState("");
  return (
    <div className="inline-form">
      <select value={v} onChange={(e) => setV(e.target.value)}>
        <option value="">Add holder…</option>
        {Object.values(agents).filter((a) => a.kind !== "service").map((a) => (
          <option key={a.id} value={a.kind === "human" ? `user:${a.ownerUserId ?? a.id}` : `agent:${a.id}`}>{a.name}{a.kind === "human" ? " (human)" : ""}</option>
        ))}
      </select>
      <Act small disabled={!v} run={async () => { const [k, id] = v.split(":") as ["agent" | "user", string]; await onAdd(k, id); setV(""); }}>Add</Act>
    </div>
  );
}

function Settings({ b }: { b: SnapshotBuilding }) {
  const [f, setF] = useState({ goal: b.goal, description: b.description, headcount: b.headcount, model: b.model, cheapModel: b.cheapModel, maxTurnsPerSession: b.maxTurnsPerSession, managerAgentId: b.managerAgentId, codeAccess: b.codeAccess });
  const [daily, setDaily] = useState(toMillions(b.dailyTokensPerAgent));
  const dailyTokens = fromMillions(daily);
  const agents = useTown((s) => s.agents);
  const repo = useTown((s) => s.town?.workspace);
  const residents = useMemo(() => Object.values(agents).filter((a) => a.kind === "resident" && a.homeBuildingId === b.id).sort((x, y) => x.name.localeCompare(y.name)), [agents, b.id]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  return (<>
    <Section title="Building">
    <form className="form" onSubmit={(e) => e.preventDefault()}>
      <Field label="Goal"><textarea rows={2} value={f.goal} onChange={(e) => set("goal", e.target.value)} /></Field>
      <Field label="Description"><textarea rows={3} value={f.description} onChange={(e) => set("description", e.target.value)} /></Field>
      <Field label="Desks (headcount)"><NumberInput min={1} max={24} value={f.headcount} onChange={(n) => set("headcount", n)} /></Field>
      <Field label="Manager" hint="The resident who works this building's in-tray (its residents' reports), facilitates its meetings and wears the ★ badge; its rollups go to the Town Hall in-tray (its own work reports stay here, and it decides them). None: you work the in-tray, and the reviewer agent, else the first resident to join, facilitates.">
        <select value={f.managerAgentId ?? ""} onChange={(e) => set("managerAgentId", e.target.value || null)}>
          <option value="">none</option>
          {residents.map((a) => <option key={a.id} value={a.id} disabled={a.status === "stopped" || a.status === "banned"}>{a.name}{a.status === "stopped" || a.status === "banned" ? ` (${a.status})` : ""}</option>)}
        </select>
      </Field>
      <div className="row2">
        <Field label="Model"><input value={f.model} onChange={(e) => set("model", e.target.value)} /></Field>
        <Field label="Cheap model"><input value={f.cheapModel} onChange={(e) => set("cheapModel", e.target.value)} /></Field>
      </div>
      <div className="row2">
        <Field label="Daily budget / agent"><MTokensInput value={daily} onChange={setDaily} /></Field>
        <Field label="Max turns / session" hint="Safety rail"><NumberInput min={1} value={f.maxTurnsPerSession} onChange={(n) => set("maxTurnsPerSession", n)} /></Field>
      </div>
      <Field label="Code access" hint={repo
        ? "Residents work on the collective's repo, each on their own branch. Every building shares this one repo; it's set for the whole collective. Needs Docker and a Claude token in the collective's .env on the host (README, Run it)."
        : "This collective has no repo yet (collective.json `workspace`), so there is nothing to give code access to."}>
        <span className="check"><input type="checkbox" checked={f.codeAccess} disabled={!repo && !f.codeAccess} onChange={(e) => set("codeAccess", e.target.checked)} /> {repo ? <>Work on <code>{repoLabel(repo)}</code></> : "No collective repo"}</span>
      </Field>
      <div className="actions"><Act tone="primary" disabled={!(dailyTokens > 0)} title={dailyTokens > 0 ? undefined : "Daily budget must be above 0" } run={async () => {
        await api().updateBuilding(b.id, { ...f, dailyTokensPerAgent: dailyTokens });
        store.toast("Settings saved", "ok");
      }}>Save settings</Act></div>
    </form>
    </Section>
    {b.kind !== "town-hall" ? <KeyResultsEditor b={b} /> : <Section title="Dashboard"><p className="direction">The town goal is three KPIs, Fund, Join and Trust, with every building's objectives under them. <button className="link" onClick={() => store.open({ kind: "dashboard" })}>Open the dashboard</button></p></Section>}
    {b.kind !== "town-hall" ? <PoolPicker b={b} /> : null}
    {b.kind !== "town-hall" && store.can("building.fund", b.id) ? <BudgetMode b={b} /> : null}
  </>);
}

/**
 * The goal's objectives and key results, the edit path (they're read on the building board; docs/goal-directed-budgets.md
 * "Objectives and KPIs"). Each objective is one sentence for the quarter naming the town KPI it moves, and holds 2 to 4
 * key results; key results under none sit in "Not under an objective yet". A human with building.manage writes them,
 * and so does the manager; status up to claimed is the manager's, met / missed need building.fund. A key result a
 * grant names can't be deleted, nor an objective that holds key results (the server says why).
 */
function KeyResultsEditor({ b }: { b: SnapshotBuilding }) {
  const rev = useTown((s) => s.rev);
  useTown((s) => s.me);
  const tree = useLoad(() => api().objectives(b.id), [b.id, rev]);
  const canFund = store.can("building.fund", b.id);
  const human = store.can("building.manage", b.id); // the web is the humans' client: a manage holder here is a human
  const objectives = tree.data?.objectives ?? [];
  const unsorted = tree.data?.unsorted ?? [];
  const all = [...objectives.flatMap((o) => o.keyResults), ...unsorted];
  const num = new Map(all.map((k, i) => [k.id, i + 1]));
  const row = (k: GoalKeyResult) => <KeyResultRow key={k.id} n={num.get(k.id)!} kr={k} canWrite={human} statuses={settableStatuses(canFund)} objectives={objectives} onChanged={tree.reload} />;
  return (
    <Section title="Objectives and key results">
      <p className="direction">{KPI_FRAMING_SHORT} Each objective is one sentence for the quarter and names the KPI it moves; its 2 to 4 key results say how you'll know, in terms a human can check in the live town. Each grant names one key result, and a goal-directed building is blocked without them. Humans write them here; the manager writes them too (from a meeting or your 1:1) and lists each key result in its next rollup, so you can keep or cut it.</p>
      {tree.loading && !tree.data ? <Loading /> : null}
      <ErrorLine error={tree.error} />
      {tree.data && !all.length && !objectives.length ? <Empty>No objectives or key results on the goal yet{b.kind !== "town-hall" ? ": the building is blocked until a key result exists or a grant is funded" : ""}.</Empty> : null}
      {objectives.map((o, i) => (
        <div key={o.id} className="kr-objective">
          <ObjectiveRow n={i + 1} o={o} canWrite={human} onChanged={tree.reload} />
          <ol className="kr-editor">{o.keyResults.map(row)}</ol>
          {o.keyResults.length < 2 ? <div className="muted kr-hint">Aim for 2 to 4 key results under each objective.</div> : null}
          {human && o.keyResults.length < MAX_KEY_RESULTS_PER_OBJECTIVE ? <AddKeyResult buildingId={b.id} objectiveId={o.id} n={all.length + 1} onChanged={tree.reload} /> : null}
        </div>
      ))}
      {objectives.length && unsorted.length ? <div className="kr-objective-head muted">Not under an objective yet: move each under one</div> : null}
      {unsorted.length ? <ol className="kr-editor">{unsorted.map(row)}</ol> : null}
      {human && !objectives.length ? <AddKeyResult buildingId={b.id} objectiveId={null} n={all.length + 1} onChanged={tree.reload} /> : null}
      {human && objectives.length < MAX_OBJECTIVES ? <AddObjective buildingId={b.id} n={objectives.length + 1} onChanged={tree.reload} /> : null}
    </Section>
  );
}

const KPI_OPTIONS: { key: KpiKey; name: string }[] = [{ key: "fund", name: "Fund" }, { key: "join", name: "Join" }, { key: "trust", name: "Trust" }];
const KPI_FRAMING_SHORT = "The town goal is three standing KPIs, Fund, Join and Trust (the town Dashboard shows them).";

/** One objective: its sentence, the KPI it moves and its quarter (humans edit), delete (refused while it holds key results). */
function ObjectiveRow({ n, o, canWrite, onChanged }: { n: number; o: ObjectiveView; canWrite: boolean; onChanged: () => void }) {
  const [f, setF] = useState<{ text: string; kpi: KpiKey | ""; horizon: string }>({ text: o.text, kpi: o.kpi ?? "", horizon: o.horizon });
  useEffect(() => setF({ text: o.text, kpi: o.kpi ?? "", horizon: o.horizon }), [o.text, o.kpi, o.horizon]);
  const dirty = f.text !== o.text || f.kpi !== (o.kpi ?? "") || f.horizon !== o.horizon;
  if (!canWrite) return <div className="kr-objective-head"><b>Objective {n}: {o.text}</b> <span className="muted">{objectiveLine(o)}</span></div>;
  return (
    <form className="form kr-objective-head" onSubmit={(e) => e.preventDefault()}>
      <Field label={`Objective ${n}`}><input value={f.text} maxLength={300} onChange={(e) => setF({ ...f, text: e.target.value })} /></Field>
      <div className="row">
        <Field label="Moves"><select value={f.kpi} onChange={(e) => setF({ ...f, kpi: e.target.value as KpiKey | "" })}>
          <option value="">(no KPI yet)</option>
          {KPI_OPTIONS.map((k) => <option key={k.key} value={k.key}>{k.name}</option>)}
        </select></Field>
        <Field label="Quarter"><input value={f.horizon} maxLength={7} placeholder="2026-Q4" onChange={(e) => setF({ ...f, horizon: e.target.value })} /></Field>
      </div>
      <div className="actions">
        <Act small tone="primary" disabled={!dirty || !f.text.trim() || !/^\d{4}-Q[1-4]$/.test(f.horizon)} run={async () => {
          await api().updateObjective(o.id, { text: f.text.trim(), kpi: f.kpi || null, horizon: f.horizon });
          store.toast(`Objective ${n} saved`, "ok");
          onChanged();
        }}>Save</Act>
        <Act small tone="bad" title="Refused while key results hang off it" run={async () => {
          if (!window.confirm(`Delete objective ${n} ("${o.text}")?`)) return;
          await api().deleteObjective(o.id);
          store.toast(`Objective ${n} deleted`, "ok");
          onChanged();
        }}>Delete</Act>
      </div>
    </form>
  );
}

function AddObjective({ buildingId, n, onChanged }: { buildingId: string; n: number; onChanged: () => void }) {
  const [f, setF] = useState({ text: "", kpi: "" as KpiKey | "" });
  return (
    <form className="form kr-add" onSubmit={(e) => e.preventDefault()}>
      <Field label={`Objective ${n}`} hint="One sentence: what the building will achieve this quarter. 2 or 3 per goal."><input value={f.text} maxLength={300} placeholder="A stranger can …" onChange={(e) => setF({ ...f, text: e.target.value })} /></Field>
      <Field label="Moves"><select value={f.kpi} onChange={(e) => setF({ ...f, kpi: e.target.value as KpiKey | "" })}>
        <option value="">(pick the KPI it moves)</option>
        {KPI_OPTIONS.map((k) => <option key={k.key} value={k.key}>{k.name}</option>)}
      </select></Field>
      <div className="actions"><Act tone="primary" disabled={!f.text.trim() || !f.kpi} run={async () => {
        await api().createObjective(buildingId, { text: f.text.trim(), kpi: f.kpi || null });
        setF({ text: "", kpi: "" });
        store.toast("Objective added: put key results under it", "ok");
        onChanged();
      }}>Add objective</Act></div>
    </form>
  );
}

function AddKeyResult({ buildingId, objectiveId, n, onChanged }: { buildingId: string; objectiveId: string | null; n: number; onChanged: () => void }) {
  const [draft, setDraft] = useState({ text: "", howToCheck: "" });
  return (
    <form className="form kr-add" onSubmit={(e) => e.preventDefault()}>
      <Field label={`Key result ${n}`}><input value={draft.text} maxLength={300} placeholder="Something a human can check in the live town" onChange={(e) => setDraft({ ...draft, text: e.target.value })} /></Field>
      <Field label="How to check"><input value={draft.howToCheck} maxLength={300} placeholder="Where to look and what you'd see" onChange={(e) => setDraft({ ...draft, howToCheck: e.target.value })} /></Field>
      <div className="actions"><Act tone="primary" disabled={!draft.text.trim() || !draft.howToCheck.trim()} run={async () => {
        await api().createKeyResult(buildingId, { text: draft.text.trim(), howToCheck: draft.howToCheck.trim(), objectiveId });
        setDraft({ text: "", howToCheck: "" });
        store.toast("Key result added: it's on the board", "ok");
        onChanged();
      }}>Add key result</Act></div>
    </form>
  );
}

/** Who wrote the key result (a human, or the building's manager from a meeting), who last edited it, and its sources. */
function KeyResultAuthor({ kr }: { kr: GoalKeyResult }) {
  const by = krAuthorLine(kr);
  if (!by && !kr.sourceDocIds.length) return null;
  return (
    <div className="muted kr-author">
      {by}
      {kr.sourceDocIds.length ? <>{by ? " · " : ""}from {kr.sourceDocIds.map((id, i) => <span key={id}>{i ? ", " : ""}<button className="link" onClick={() => void openDocLink(id)}>{store.state.docs[id]?.title ?? id}</button></span>)}</> : null}
    </div>
  );
}

/** One key result in the editor: words (humans), status (per `statuses`), delete. Dirty rows save explicitly. */
function KeyResultRow({ n, kr, canWrite, statuses, objectives, onChanged }: { n: number; kr: GoalKeyResult; canWrite: boolean; statuses: KeyResultStatus[]; objectives: ObjectiveView[]; onChanged: () => void }) {
  const [f, setF] = useState({ text: kr.text, howToCheck: kr.howToCheck });
  useEffect(() => setF({ text: kr.text, howToCheck: kr.howToCheck }), [kr.text, kr.howToCheck]);
  const dirty = f.text !== kr.text || f.howToCheck !== kr.howToCheck;
  const canStatus = statuses.includes(kr.status);
  const setStatus = async (status: KeyResultStatus) => {
    if (status === kr.status) return;
    await api().updateKeyResult(kr.id, { status });
    store.toast(`Key result ${n} is ${krStatusLabel(status)}`, "ok");
    onChanged();
  };
  return (
    <li className="kr-editor-row">
      <div className="kr-row-head">
        <span className="kr-n">{n}</span>
        {canStatus ? (
          <select className={`kr-status ${krTone(kr.status)}`} value={kr.status} title={kr.statusNote || "Status"} onChange={(e) => setStatus(e.target.value as KeyResultStatus).catch((err) => store.toast((err as Error).message, "bad"))}>
            {statuses.map((s) => <option key={s} value={s}>{krStatusLabel(s)}</option>)}
          </select>
        ) : <Pill tone={krTone(kr.status)} title={kr.statusNote || undefined}>{krStatusLabel(kr.status)}</Pill>}
        {canWrite ? null : <b>{kr.text}</b>}
        {canWrite && objectives.length ? (
          <select className="kr-move" value={kr.objectiveId ?? ""} title="The objective it serves" aria-label={`Objective of key result ${n}`} onChange={(e) => {
            api().updateKeyResult(kr.id, { objectiveId: e.target.value || null }).then(() => { store.toast(`Key result ${n} moved`, "ok"); onChanged(); }, (err) => store.toast((err as Error).message, "bad"));
          }}>
            <option value="">{kr.objectiveId ? "Not under an objective" : "Move under…"}</option>
            {objectives.map((o, i) => <option key={o.id} value={o.id}>Objective {i + 1}: {o.text}</option>)}
          </select>
        ) : null}
      </div>
      {canWrite ? (
        <form className="form" onSubmit={(e) => e.preventDefault()}>
          <input value={f.text} maxLength={300} aria-label={`Key result ${n}`} onChange={(e) => setF({ ...f, text: e.target.value })} />
          <input value={f.howToCheck} maxLength={300} aria-label={`How to check ${n}`} placeholder="How to check" onChange={(e) => setF({ ...f, howToCheck: e.target.value })} />
          <div className="actions">
            <Act small tone="primary" disabled={!dirty || !f.text.trim() || !f.howToCheck.trim()} run={async () => {
              await api().updateKeyResult(kr.id, { text: f.text.trim(), howToCheck: f.howToCheck.trim() });
              store.toast(`Key result ${n} saved`, "ok");
              onChanged();
            }}>Save</Act>
            {dirty ? <button className="link" onClick={() => setF({ text: kr.text, howToCheck: kr.howToCheck })}>Undo</button> : null}
            <Act small tone="bad" title="Refused while a grant names it" run={async () => {
              if (!window.confirm(`Delete key result ${n} ("${kr.text}")?`)) return;
              await api().deleteKeyResult(kr.id);
              store.toast(`Key result ${n} deleted`, "ok");
              onChanged();
            }}>Delete</Act>
          </div>
        </form>
      ) : <div className="muted kr-check">How to check: {kr.howToCheck}</div>}
      <KeyResultAuthor kr={kr} />
    </li>
  );
}

/** The exploration allowance and forks (docs/goal-directed-budgets.md); every lab is goal-directed. Humans who can fund only: a manager agent can't change its own budget. */
function BudgetMode({ b }: { b: SnapshotBuilding }) {
  const [explore, setExplore] = useState(b.explorationTokensPerDay == null ? "" : toMillions(b.explorationTokensPerDay));
  return (
    <Section title="Budget mode">
      <form className="form" onSubmit={(e) => e.preventDefault()}>
        <Field label="Exploration / day" hint="Leave blank for the default: 10% of the pool's daily inflow.">
          <MTokensInput value={explore} placeholder="default" onChange={setExplore} />
        </Field>
        <ForksToggle b={b} />
        <div className="actions"><Act tone="primary" run={async () => {
          await api().updateBuilding(b.id, { explorationTokensPerDay: explore.trim() === "" ? null : Math.max(0, fromMillions(explore) || 0) });
          store.toast(`${b.name} budget settings saved`, "ok");
        }}>Save budget mode</Act></div>
      </form>
    </Section>
  );
}

export const FORKS_HINT = "Queued building work runs on forks of the manager";

/** The Forks switch's markup; `on` null = still reading the live value. */
export function ForksField({ on, busy, onChange }: { on: boolean | null; busy?: boolean; onChange: (on: boolean) => void }) {
  return (
    <Field label="Forks" hint={FORKS_HINT}>
      <span className="check"><input type="checkbox" aria-label="Forks" checked={!!on} disabled={on === null || busy} onChange={(e) => onChange(e.target.checked)} /> {on === null ? "…" : on ? "on" : "off"}</span>
    </Field>
  );
}

/** Manager forks on/off (PATCH /api/buildings/:id {forks}, building.fund); reads the live value from GET /api/buildings/:id and saves on click. */
function ForksToggle({ b }: { b: SnapshotBuilding }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api().building(b.id).then((x) => { if (live) setOn(x.forks); }, () => { if (live) setOn(b.forks); });
    return () => { live = false; };
  }, [b.id, b.forks]);
  return <ForksField on={on} busy={busy} onChange={async (next) => {
    setBusy(true);
    try {
      const saved = await api().updateBuilding(b.id, { forks: next });
      setOn(saved.forks);
      store.toast(`Forks ${saved.forks ? "on" : "off"} for ${b.name}`, "ok");
    } catch (e) {
      store.toast((e as Error).message, "bad");
    } finally { setBusy(false); }
  }} />;
}

/** The Bank pool this building draws from. Only an admin can move it; the move takes effect at once. */
function PoolPicker({ b }: { b: SnapshotBuilding }) {
  const bank = useTown((s) => s.bank);
  const isAdmin = useTown((s) => !!s.me?.isAdmin);
  const buildings = useTown((s) => s.buildings);
  const row = bank?.buildings.find((x) => x.buildingId === b.id);
  const poolId = row?.poolId ?? b.poolId ?? DEFAULT_POOL_ID;
  const reload = () => api().bank().then((next) => store.set({ bank: next }), () => undefined);
  useEffect(() => { if (!bank) reload(); }, [bank]);
  // the Town Hall sits in General but draws nothing, so it doesn't count as sharing
  const others = (members: { buildingId: string }[]) => {
    const n = members.filter((m) => m.buildingId !== b.id && buildings.find((x) => x.id === m.buildingId)?.kind !== "town-hall").length;
    return n ? `shared with ${n} other building${n === 1 ? "" : "s"}` : "all for this building";
  };
  return (
    <Section title="Bank pool">
      {!bank ? <Loading /> : (
        <form className="form" onSubmit={(e) => e.preventDefault()}>
          <Field label="Pool" hint={isAdmin
            ? "Buildings in a pool share its % of the Bank, first come first served. Moving takes effect at once; what this building already drew stays charged to its old pool. Create and size pools at the Bank."
            : "Buildings in a pool share its % of the Bank, first come first served. Only an admin can move a building to another pool."}>
            <span className="pool-pick">
              <span className="pool-swatch" style={{ background: poolColor(bank, poolId) }} />
              <select value={poolId} disabled={!isAdmin} onChange={async (e) => {
                const next = e.target.value;
                try {
                  await api().setBuildingPool(b.id, next);
                  store.toast(`${b.name} now draws from ${bank.pools.find((p) => p.id === next)?.name ?? "the pool"}`, "ok");
                } catch (err) { store.toast((err as Error).message, "bad"); }
                reload();
              }}>
                {bank.pools.map((p) => <option key={p.id} value={p.id}>{p.name} · {fmtPct(p.pct)}{p.explicit ? "" : " (auto)"}</option>)}
              </select>
            </span>
          </Field>
          {row ? <div className="foot-note">The pool can still draw {fmtTokens(row.expiringTokens + Math.max(0, row.durableTokens))} today ({fmtTokens(row.expiringTokens)} expiring, {fmtTokens(row.durableTokens)} permanent), {others(bank.pools.find((p) => p.id === poolId)?.buildings ?? [])}.</div> : null}
        </form>
      )}
    </Section>
  );
}

function NewResident({ buildingId }: { buildingId: string }) {
  const [name, setName] = useState("");
  const [sprite, setSprite] = useState(1);
  const [seen, setSeen] = useState<string[]>([]);
  const suggest = async (avoid: string[]) => {
    const n = await api().suggestName(avoid);
    setName(n);
    setSeen([...avoid, n]);
  };
  useEffect(() => { suggest([]).catch(() => {}); }, [buildingId]);
  return (
    <Section title="New resident">
      <form className="form" onSubmit={(e) => e.preventDefault()}>
        <Field label="Name" hint="The town suggests an unused name; reroll it or type your own. Residents have no title or job description: they take whatever assignment they're given, end to end.">
          <div className="name-pick">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Leave blank and the town picks one" />
            <Act small title="Suggest another name" run={() => suggest(seen)}>Reroll</Act>
          </div>
        </Field>
        <Field label="Look">
          <div className="sprites">
            {PALETTES.map((_, i) => i === 7 ? null : (
              <button type="button" key={i} className={i === sprite ? "on" : ""} onClick={() => setSprite(i)}><img src={portraitUrl(i, 2)} alt={`sprite ${i}`} /></button>
            ))}
          </div>
        </Field>
        <div className="actions">
          <Act tone="primary" run={async () => {
            const a = await api().createResident({ buildingId, name: name.trim() || undefined, sprite });
            await suggest([a.name]).catch(() => setName(""));
            store.toast(`${a.name} moved in`, "ok", { kind: "agent", id: a.id });
          }}>Add resident</Act>
        </div>
      </form>
    </Section>
  );
}
