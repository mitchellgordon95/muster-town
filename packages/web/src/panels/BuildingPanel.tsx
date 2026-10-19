/** Building panel: goal, members, budget, board, meetings, roles, settings (managers). */
import { useMemo, useState } from "react";
import type { Building, Doc, Meeting } from "@agent-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { DocRow, DocView } from "./DocView";
import { Glyph, PanelShell } from "./PanelShell";
import { Meter } from "./AgentPanel";
import { Act, Empty, ErrorLine, Field, KV, Loading, Pill, Section, StatusPill, fmtTokens, nameOf, timeAgo, usd, useLoad } from "./ui";
import { portraitUrl } from "../map/sprites";

export function BuildingPanel({ id, tab }: { id: string; tab?: string }) {
  const b = useTown((s) => s.buildings.find((x) => x.id === id));
  useTown((s) => s.me);
  if (!b) return <PanelShell title="Unknown building"><Empty>No building with id {id}.</Empty></PanelShell>;
  const tabs = ["Overview", "Board", "Meetings", "Roles", ...(store.can("building.manage", id) ? ["Settings"] : [])];
  return (
    <PanelShell icon={<Glyph kind="building" />} title={b.name} subtitle={`${b.kind === "town-hall" ? "Town Hall" : "Lab"} · review: ${b.reviewPolicy}`} tabs={tabs} initialTab={tab && tabs.includes(tab) ? tab : "Overview"}>
      {(t) => (
        <>
          {t === "Overview" ? <Overview b={b} /> : null}
          {t === "Board" ? <Board b={b} /> : null}
          {t === "Meetings" ? <MeetingsTab b={b} /> : null}
          {t === "Roles" ? <RolesTab buildingId={b.id} /> : null}
          {t === "Settings" ? <Settings b={b} /> : null}
        </>
      )}
    </PanelShell>
  );
}

function Overview({ b }: { b: Building }) {
  const agents = useTown((s) => s.agents);
  const members = useMemo(() => Object.values(agents).filter((a) => (a.homeBuildingId ?? a.buildingId) === b.id && a.kind !== "human"), [agents, b.id]);
  const budget = useLoad(() => api().budget(), [b.id]);
  const row = budget.data?.buildings.find((x) => x.buildingId === b.id);
  return (
    <>
      {b.goal ? <div className="goal-card"><span>Goal</span>{b.goal}</div> : null}
      {b.description ? <p className="direction">{b.description}</p> : null}
      {b.kind !== "town-hall" ? (
        <KV items={[
          ["Budget", row ? <>{fmtTokens(row.allocated - row.spent)} left of {fmtTokens(row.allocated)} <Meter v={row.allocated ? row.spent / row.allocated : 0} /></> : budget.loading ? "…" : "no allocation"],
          ["Spent", row?.spentUsd !== undefined ? usd(row.spentUsd) : "—"],
          ["Models", `${b.model} · cheap: ${b.cheapModel}`],
          ["Daily / agent", `${fmtTokens(b.dailyTokensPerAgent)} tokens`],
          ["Desks", `${members.filter((m) => m.kind === "resident").length} / ${b.headcount}`],
        ]} />
      ) : null}
      <Section title="Members">
        {!members.length ? <Empty>No one works here yet.</Empty> : (
          <div className="members">
            {members.map((a) => (
              <button key={a.id} className="member" onClick={() => store.open({ kind: "agent", id: a.id })}>
                <img src={portraitUrl(a.sprite, 2)} alt="" />
                <div><b>{a.name}</b><span>{a.title}</span></div>
                <StatusPill status={a.status} />
              </button>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function Board({ b }: { b: Building }) {
  const rev = useTown((s) => s.rev);
  const list = useLoad(() => api().board(b.id, 40), [b.id, rev]);
  const [open, setOpen] = useState<Doc | null>(null);
  if (open) return <DocView doc={open} onBack={() => setOpen(null)} backLabel="Board" />;
  if (list.loading && !list.data) return <Loading />;
  return (
    <>
      <ErrorLine error={list.error} />
      {!list.data?.length ? <Empty>Nothing published to the board yet.</Empty> : <div className="doc-list">{list.data.map((d) => <DocRow key={d.id} doc={d} onOpen={() => setOpen(d)} />)}</div>}
    </>
  );
}

export function phaseTone(p: Meeting["phase"]) { return p === "collecting" ? "warn" : p === "discussing" ? "ok" : p === "done" ? "" : p === "cancelled" ? "bad" : "info"; }

function MeetingsTab({ b }: { b: Building }) {
  const all = useTown((s) => s.meetings);
  const list = useMemo(() => Object.values(all).filter((m) => m.buildingId === b.id || (b.kind === "town-hall" && m.buildingId === null)).sort((x, y) => y.createdAt.localeCompare(x.createdAt)), [all, b]);
  const can = store.can("meeting.facilitate", b.id) || store.can("building.manage", b.id);
  const [kind, setKind] = useState<Meeting["kind"]>(b.kind === "town-hall" ? "town-hall" : "standup");
  return (
    <>
      {can ? (
        <div className="inline-form">
          <select value={kind} onChange={(e) => setKind(e.target.value as Meeting["kind"])}>
            {(["standup", "retro", "planning", "town-hall"] as const).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <Act tone="primary" run={async () => {
            const m = await api().createMeeting({ kind, buildingId: b.kind === "town-hall" ? null : b.id, startNow: true });
            store.putMeeting(m); store.open({ kind: "meeting", id: m.id });
          }}>Call meeting</Act>
        </div>
      ) : null}
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

function Settings({ b }: { b: Building }) {
  const [f, setF] = useState({ goal: b.goal, description: b.description, reviewPolicy: b.reviewPolicy, headcount: b.headcount, model: b.model, cheapModel: b.cheapModel, dailyTokensPerAgent: b.dailyTokensPerAgent, maxTurnsPerSession: b.maxTurnsPerSession });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  return (
    <form className="form" onSubmit={(e) => e.preventDefault()}>
      <Field label="Goal"><textarea rows={2} value={f.goal} onChange={(e) => set("goal", e.target.value)} /></Field>
      <Field label="Description"><textarea rows={3} value={f.description} onChange={(e) => set("description", e.target.value)} /></Field>
      <div className="row2">
        <Field label="Review policy" hint="Who decides on reports">
          <select value={f.reviewPolicy} onChange={(e) => set("reviewPolicy", e.target.value as Building["reviewPolicy"])}>
            <option value="human">human</option><option value="moderator">moderator</option><option value="auto">auto</option>
          </select>
        </Field>
        <Field label="Desks (headcount)"><input type="number" min={1} max={24} value={f.headcount} onChange={(e) => set("headcount", +e.target.value)} /></Field>
      </div>
      <div className="row2">
        <Field label="Model"><input value={f.model} onChange={(e) => set("model", e.target.value)} /></Field>
        <Field label="Cheap model"><input value={f.cheapModel} onChange={(e) => set("cheapModel", e.target.value)} /></Field>
      </div>
      <div className="row2">
        <Field label="Daily tokens / agent"><input type="number" min={1} value={f.dailyTokensPerAgent} onChange={(e) => set("dailyTokensPerAgent", +e.target.value)} /></Field>
        <Field label="Max turns / session" hint="Safety rail"><input type="number" min={1} value={f.maxTurnsPerSession} onChange={(e) => set("maxTurnsPerSession", +e.target.value)} /></Field>
      </div>
      <div className="actions"><Act tone="primary" run={async () => { await api().updateBuilding(b.id, f); store.toast("Settings saved", "ok"); }}>Save settings</Act></div>
    </form>
  );
}
