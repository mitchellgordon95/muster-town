/** Building panel (E at the door): overview, members + roles, meetings, settings (managers). Board, filing cabinet and in-tray are places. */
import { useMemo, useState, type ReactNode } from "react";
import type { Meeting, SnapshotBuilding, Workspace } from "@agent-town/schema";
import { api } from "../api";
import { store, useTown, roleOf } from "../state";
import { Glyph, PanelShell } from "./PanelShell";
import { Meter } from "./AgentPanel";
import { DismissButton, canDismiss } from "./Dismiss";
import { Act, Empty, ErrorLine, Field, KV, Loading, Pill, Section, StatusPill, fmtTokens, nameOf, timeAgo, usd, useLoad } from "./ui";
import { portraitUrl } from "../map/sprites";
import { AttendeePicker, useAttendees } from "./AttendeePicker";
import { attendeeInput } from "./attendees";

export function BuildingPanel({ id, tab }: { id: string; tab?: string }) {
  const b = useTown((s) => s.buildings.find((x) => x.id === id));
  useTown((s) => s.me);
  if (!b) return <PanelShell title="Unknown building"><Empty>No building with id {id}.</Empty></PanelShell>;
  const tabs = ["Overview", "Members", "Meetings", ...(store.can("building.manage", id) ? ["Settings"] : [])];
  return (
    <PanelShell icon={<Glyph kind="building" />} title={b.name} subtitle={`${b.kind === "town-hall" ? "Town Hall" : "Lab"} · review: ${b.reviewPolicy}${b.workspace ? ` · merge: ${b.workspace.merge}` : ""}`} tabs={tabs} initialTab={tab && tabs.includes(tab) ? tab : "Overview"}>
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

function Overview({ b }: { b: SnapshotBuilding }) {
  const agents = useTown((s) => s.agents);
  const members = useMemo(() => Object.values(agents).filter((a) => (a.homeBuildingId ?? a.buildingId) === b.id && a.kind === "resident"), [agents, b.id]);
  const budget = useLoad(() => api().budget(), [b.id]);
  const row = budget.data?.buildings.find((x) => x.buildingId === b.id);
  const places = useTown((s) => s.places);
  const hasBoard = places.some((p) => p.id === `board:${b.id}`);
  const hasCabinet = places.some((p) => p.id === `cabinet:${b.id}`);
  const hasTray = places.some((p) => p.id === `intray:${b.id}`);
  return (
    <>
      {b.goal ? <div className="goal-card"><span>Goal</span>{b.goal}</div> : null}
      {b.description ? <p className="direction">{b.description}</p> : null}
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
      {b.kind !== "town-hall" ? (
        <KV items={[
          ["Budget", row ? <>{fmtTokens(row.allocated - row.spent)} left of {fmtTokens(row.allocated)} <Meter v={row.allocated ? row.spent / row.allocated : 0} /></> : budget.loading ? "…" : "no allocation"],
          ["Spent", row?.spentUsd !== undefined ? usd(row.spentUsd) : "—"],
          ["Models", `${b.model} · cheap: ${b.cheapModel}`],
          ["Daily / agent", `${fmtTokens(b.dailyTokensPerAgent)} tokens`],
          ["Daily pool", b.dailyTokens == null ? "no daily limit" : row?.spentTodayTokens !== undefined ? <>{fmtTokens(row.spentTodayTokens)} of {fmtTokens(b.dailyTokens)} today <Meter v={row.spentTodayTokens / b.dailyTokens} /></> : `${fmtTokens(b.dailyTokens)} tokens`],
          ["Desks", `${members.length} / ${b.headcount}`],
          ["Review", b.reviewPolicy === "human" ? "the manager works the in-tray" : b.reviewPolicy === "reviewer" ? "the reviewer agent works the in-tray" : "reports are acknowledged on arrival"],
          ...(b.workspace ? [["Workspace", <><code>{b.workspace.path}</code> · merge {b.workspace.merge}</>] as [string, ReactNode]] : []),
        ]} />
      ) : null}
    </>
  );
}

function Members({ b }: { b: SnapshotBuilding }) {
  const agents = useTown((s) => s.agents);
  useTown((s) => s.me);
  const members = useMemo(() => Object.values(agents).filter((a) => (a.homeBuildingId ?? a.buildingId) === b.id && a.kind !== "human"), [agents, b.id]);
  return (
    <>
      <Section title={`Residents (${members.length})`}>
        {!members.length ? <Empty>No one works here yet.</Empty> : (
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
      <RolesTab buildingId={b.id} />
    </>
  );
}

export function phaseTone(p: Meeting["phase"]) { return p === "collecting" ? "warn" : p === "discussing" ? "ok" : p === "done" ? "" : p === "cancelled" ? "bad" : "info"; }

function MeetingsTab({ b }: { b: SnapshotBuilding }) {
  const all = useTown((s) => s.meetings);
  const list = useMemo(() => Object.values(all).filter((m) => m.buildingId === b.id || (b.kind === "town-hall" && m.buildingId === null)).sort((x, y) => y.createdAt.localeCompare(x.createdAt)), [all, b]);
  const can = store.can("meeting.facilitate", b.id) || store.can("building.manage", b.id);
  const [kind, setKind] = useState<Meeting["kind"]>(b.kind === "town-hall" ? "town-hall" : "standup");
  const invite = useAttendees(b);
  return (
    <>
      {can ? (<>
        <div className="inline-form">
          <select value={kind} onChange={(e) => setKind(e.target.value as Meeting["kind"])}>
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
  const [f, setF] = useState({ goal: b.goal, description: b.description, reviewPolicy: b.reviewPolicy, headcount: b.headcount, model: b.model, cheapModel: b.cheapModel, dailyTokensPerAgent: b.dailyTokensPerAgent, dailyTokens: b.dailyTokens, maxTurnsPerSession: b.maxTurnsPerSession });
  const [merge, setMerge] = useState<Workspace["merge"]>(b.workspace?.merge ?? "human");
  const [checks, setChecks] = useState((b.workspace?.checks ?? []).join("\n"));
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  return (
    <form className="form" onSubmit={(e) => e.preventDefault()}>
      <Field label="Goal"><textarea rows={2} value={f.goal} onChange={(e) => set("goal", e.target.value)} /></Field>
      <Field label="Description"><textarea rows={3} value={f.description} onChange={(e) => set("description", e.target.value)} /></Field>
      <div className="row2">
        <Field label="Review policy" hint={f.reviewPolicy === "human" ? "You work the in-tray" : f.reviewPolicy === "reviewer" ? "The reviewer agent works the in-tray" : "Every report is acknowledged on arrival"}>
          <select value={f.reviewPolicy} onChange={(e) => set("reviewPolicy", e.target.value as SnapshotBuilding["reviewPolicy"])}>
            <option value="human">human</option><option value="reviewer">reviewer</option><option value="auto">auto</option>
          </select>
        </Field>
        <Field label="Desks (headcount)"><input type="number" min={1} max={24} value={f.headcount} onChange={(e) => set("headcount", +e.target.value)} /></Field>
      </div>
      <div className="row2">
        <Field label="Model"><input value={f.model} onChange={(e) => set("model", e.target.value)} /></Field>
        <Field label="Cheap model"><input value={f.cheapModel} onChange={(e) => set("cheapModel", e.target.value)} /></Field>
      </div>
      <div className="row2">
        <Field label="Max tokens / agent / day" hint="Ceiling for one resident"><input type="number" min={1} value={f.dailyTokensPerAgent} onChange={(e) => set("dailyTokensPerAgent", +e.target.value)} /></Field>
        <Field label="Daily pool (tokens)" hint="Residents draw from it as they work; empty = no limit"><input type="number" min={1} value={f.dailyTokens ?? ""} onChange={(e) => set("dailyTokens", e.target.value ? +e.target.value : null)} /></Field>
      </div>
      <div className="row2">
        <Field label="Max turns / session" hint="Safety rail"><input type="number" min={1} value={f.maxTurnsPerSession} onChange={(e) => set("maxTurnsPerSession", +e.target.value)} /></Field>
      </div>
      {b.workspace ? (
        <>
          <div className="row2">
            <Field label="Merge" hint={merge === "green" ? "The desk readies and squash-merges its PR when every check passes" : "PRs stay draft for a human"}>
              <select value={merge} onChange={(e) => setMerge(e.target.value as Workspace["merge"])}>
                <option value="human">human</option><option value="green">green</option>
              </select>
            </Field>
            <Field label="Workspace"><input value={b.workspace.path} disabled /></Field>
          </div>
          <Field label="Checks" hint="One command per line, run in the checkout before a green merge">
            <textarea rows={3} value={checks} onChange={(e) => setChecks(e.target.value)} placeholder={"npm run typecheck\nnpm test"} />
          </Field>
        </>
      ) : null}
      <div className="actions"><Act tone="primary" run={async () => {
        const workspace = b.workspace ? { ...b.workspace, merge, checks: checks.split("\n").map((x) => x.trim()).filter(Boolean) } : undefined;
        await api().updateBuilding(b.id, { ...f, ...(workspace ? { workspace } : {}) });
        store.toast("Settings saved", "ok");
      }}>Save settings</Act></div>
    </form>
  );
}
