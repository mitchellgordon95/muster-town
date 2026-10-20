/**
 * Panels that belong to places on the map: the in-tray (manager's desk), the building board,
 * the donation box, the schedule board and the mod station (Town Hall).
 */
import { useEffect, useMemo, useState } from "react";
import type { Doc, Meeting } from "@agent-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { DocRow, DocView, VERDICT_TONE, proposalOf } from "./DocView";
import { Glyph, PanelShell } from "./PanelShell";
import { Meter } from "./AgentPanel";
import { phaseTone } from "./BuildingPanel";
import { RequestCard } from "./OutboxPanel";
import { Markdown } from "./Markdown";
import { Act, Empty, ErrorLine, Field, Loading, Pill, Section, clock, fmtTokens, nameOf, timeAgo, usd, useLoad } from "./ui";
import { portraitUrl } from "../map/sprites";

// ---------- in-tray ----------

export function IntrayPanel({ buildingId }: { buildingId: string }) {
  const b = useTown((s) => s.buildings.find((x) => x.id === buildingId));
  const rev = useTown((s) => s.rev);
  useTown((s) => s.me);
  // refetch whenever the count on the building changes (WS `building`) or any doc arrives
  const list = useLoad(() => api().intray(buildingId), [buildingId, b?.intray, rev]);
  const [openId, setOpenId] = useState<string | null>(null);
  const canReview = store.can("building.review", buildingId);
  const reports = useMemo(() => [...(list.data ?? [])].sort((x, y) => x.createdAt.localeCompare(y.createdAt)), [list.data]);
  useEffect(() => { if (list.data) store.putDocs(list.data); }, [list.data]);
  const open = openId ? reports.find((d) => d.id === openId) ?? store.state.docs[openId] ?? null : null;
  if (!b) return <PanelShell title="In-tray"><Empty>No building with id {buildingId}.</Empty></PanelShell>;
  const subtitle = `${b.name} · manager's desk · review: ${b.reviewPolicy}`;
  return (
    <PanelShell icon={<Glyph kind="intray" />} title={<>In-tray {reports.length ? <Pill tone="warn">{reports.length}</Pill> : null}</>} subtitle={subtitle}>
      {open ? (
        <DocView doc={open} review onBack={() => setOpenId(null)} backLabel="In-tray" onDecided={() => { setOpenId(null); list.reload(); }} />
      ) : (
        <>
          {!canReview ? <div className="callout">You can read the in-tray. Decisions are for the building's manager and reviewer.</div> : null}
          {b.reviewPolicy === "auto" ? <div className="callout">This building acknowledges every report on arrival (review policy: auto).</div> : null}
          {b.reviewPolicy === "reviewer" ? <div className="callout">The building's reviewer agent works this in-tray. You can still decide here.</div> : null}
          <ErrorLine error={list.error} />
          {list.loading && !list.data ? <Loading /> : !reports.length ? <Empty>The in-tray is empty. When a resident finishes a session, its report lands here and the resident goes idle.</Empty> : (
            <div className="doc-list">
              {reports.map((d) => <IntrayRow key={d.id} doc={d} onOpen={() => setOpenId(d.id)} />)}
            </div>
          )}
        </>
      )}
    </PanelShell>
  );
}

function IntrayRow({ doc, onOpen }: { doc: Doc; onOpen: () => void }) {
  const a = useTown((s) => s.agents[doc.authorId]);
  const proposal = proposalOf(doc.body);
  return (
    <button className="doc-row intray-row" onClick={onOpen}>
      <div className="intray-who">{a ? <img src={portraitUrl(a.sprite, 1)} alt="" /> : null}<b>{nameOf(doc.authorId)}</b><span>{timeAgo(doc.createdAt)}</span></div>
      <div className="doc-row-title">{doc.title}</div>
      {proposal ? <div className="intray-proposal">Proposes: {proposal.length > 140 ? proposal.slice(0, 140) + "…" : proposal}</div> : null}
      <div className="doc-row-meta">
        {doc.verdict ? <Pill tone={VERDICT_TONE[doc.verdict]}>verdict: {doc.verdict}</Pill> : null}
        {doc.tokens ? <span>{fmtTokens(doc.tokens)} tokens{doc.costUsd ? ` · ${usd(doc.costUsd)}` : ""}</span> : null}
      </div>
    </button>
  );
}

// ---------- board ----------

export function BoardPanel({ buildingId }: { buildingId: string }) {
  const b = useTown((s) => s.buildings.find((x) => x.id === buildingId));
  const rev = useTown((s) => s.rev);
  const list = useLoad(() => api().board(buildingId, 50), [buildingId, rev]);
  const [open, setOpen] = useState<Doc | null>(null);
  useEffect(() => { if (list.data) store.putDocs(list.data); }, [list.data]);
  return (
    <PanelShell icon={<Glyph kind="board" />} title={`${b?.name ?? "Building"} board`} subtitle="Reports, articles and notes published in this building">
      {open ? <DocView doc={open} onBack={() => setOpen(null)} backLabel="Board" /> : (
        <>
          <ErrorLine error={list.error} />
          {list.loading && !list.data ? <Loading /> : !list.data?.length ? <Empty>Nothing pinned to the board yet.</Empty> : (
            <div className="doc-list">{list.data.map((d) => <DocRow key={d.id} doc={d} onOpen={() => setOpen(d)} />)}</div>
          )}
        </>
      )}
    </PanelShell>
  );
}

// ---------- donation box ----------

export function DonationPanel() {
  const buildings = useTown((s) => s.buildings).filter((b) => b.kind !== "town-hall");
  const budget = useLoad(() => api().budget(), []);
  const [tokens, setTokens] = useState(1_000_000);
  const [buildingId, setBuildingId] = useState(buildings[0]?.id ?? "");
  const [apiKey, setApiKey] = useState("");
  return (
    <PanelShell icon={<Glyph kind="donation" />} title="Donation box" subtitle="Fund a building's research with tokens">
      <Section title="Donate tokens">
        <form className="form" onSubmit={(e) => e.preventDefault()}>
          <div className="row2">
            <Field label="Tokens"><input type="number" min={1} step={100000} value={tokens} onChange={(e) => setTokens(+e.target.value)} /></Field>
            <Field label="Building">
              <select value={buildingId} onChange={(e) => setBuildingId(e.target.value)}>{buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            </Field>
          </div>
          <Field label="Anthropic API key (optional)" hint="Sessions charged to this donation run on your key. Stored server-side, never shown again.">
            <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-ant-…" />
          </Field>
          <div className="actions"><Act tone="primary" disabled={tokens < 1 || !buildingId} run={async () => {
            await api().donate({ tokens, buildingId, apiKey: apiKey.trim() || undefined });
            setApiKey(""); budget.reload();
            store.toast(`Donated ${fmtTokens(tokens)} tokens`, "ok");
          }}>Donate</Act></div>
        </form>
      </Section>
      <Section title="Allocations">
        <ErrorLine error={budget.error} />
        {budget.loading && !budget.data ? <Loading /> : (
          <table className="table">
            <thead><tr><th>Building</th><th>Allocated</th><th>Spent</th><th /></tr></thead>
            <tbody>
              {(budget.data?.buildings ?? []).map((r) => (
                <tr key={r.buildingId}>
                  <td>{buildings.find((b) => b.id === r.buildingId)?.name ?? r.buildingId}</td>
                  <td>{fmtTokens(r.allocated)}</td>
                  <td>{fmtTokens(r.spent)}{r.spentUsd !== undefined ? ` · ${usd(r.spentUsd)}` : ""}</td>
                  <td><Meter v={r.allocated ? r.spent / r.allocated : 0} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {budget.data?.users.length ? <div className="foot-note">Donors: {budget.data.users.map((u) => `${u.name ?? u.userId} (${fmtTokens(u.donated)})`).join(", ")}</div> : null}
      </Section>
    </PanelShell>
  );
}

// ---------- schedule board ----------

/** Walk to the meeting's room, then open it. */
export function joinMeeting(m: Meeting) {
  const hall = store.state.buildings.find((b) => b.kind === "town-hall");
  const room = `meeting-room:${m.buildingId ?? hall?.id ?? ""}`;
  if (!store.walkTo(room, { kind: "meeting", id: m.id })) store.open({ kind: "meeting", id: m.id });
}

export function SchedulePanel() {
  const live = useTown((s) => s.meetings);
  const buildings = useTown((s) => s.buildings);
  const rev = useTown((s) => s.rev);
  useTown((s) => s.me);
  // the snapshot carries only scheduled/active meetings; fetch the rest for "recent"
  const all = useLoad(() => api().meetings({}), [rev]);
  const merged = useMemo(() => {
    const m = new Map<string, Meeting>();
    for (const x of all.data ?? []) m.set(x.id, x);
    for (const x of Object.values(live)) m.set(x.id, x);
    return [...m.values()];
  }, [all.data, live]);
  const upcoming = merged.filter((m) => m.phase === "scheduled" || m.phase === "collecting" || m.phase === "discussing")
    .sort((a, b) => (a.phase === "scheduled" ? 1 : 0) - (b.phase === "scheduled" ? 1 : 0) || a.scheduledAt.localeCompare(b.scheduledAt));
  const recent = merged.filter((m) => m.phase === "done" || m.phase === "cancelled").sort((a, b) => (b.endedAt ?? b.scheduledAt).localeCompare(a.endedAt ?? a.scheduledAt)).slice(0, 12);
  const where = (m: Meeting) => (m.buildingId ? buildings.find((b) => b.id === m.buildingId)?.name ?? m.buildingId : "Town Hall");
  const row = (m: Meeting) => {
    const canRun = store.can("meeting.facilitate", m.buildingId) || store.can("building.manage", m.buildingId);
    const active = m.phase === "collecting" || m.phase === "discussing";
    return (
      <div key={m.id} className="sched-row">
        <div className="sched-when">{m.phase === "scheduled" ? <>{clock(m.scheduledAt)}<small>{dayOf(m.scheduledAt)}</small></> : active ? <Pill tone={phaseTone(m.phase)}>{m.phase}</Pill> : <small>{timeAgo(m.endedAt ?? m.scheduledAt)}</small>}</div>
        <div className="sched-what">
          <button className="link title" onClick={() => store.open({ kind: "meeting", id: m.id })}>{m.title}</button>
          <span>{where(m)} · {m.kind} · {m.attendeeIds.length} attendees</span>
        </div>
        <div className="sched-act">
          {m.phase === "scheduled" && canRun ? <Act small tone="primary" run={async () => { const x = await api().startMeeting(m.id); store.putMeeting(x); joinMeeting(x); }}>Start</Act> : null}
          {active ? <button className="btn sm ok" onClick={() => joinMeeting(m)}>Join</button> : null}
          {m.phase === "done" && m.notesDocId ? <button className="btn sm" onClick={() => store.open({ kind: "library", docId: m.notesDocId! })}>Notes</button> : null}
        </div>
      </div>
    );
  };
  return (
    <PanelShell icon={<Glyph kind="schedule" />} title="Schedule board" subtitle="Meetings in every building">
      <ErrorLine error={all.error} />
      <Section title={`Now and upcoming (${upcoming.length})`}>
        {!upcoming.length ? <Empty>Nothing scheduled. Managers call meetings from a building's meeting room.</Empty> : upcoming.map(row)}
      </Section>
      <Section title="Recent">
        {all.loading && !all.data ? <Loading /> : !recent.length ? <Empty>No meetings have finished yet.</Empty> : recent.map(row)}
      </Section>
    </PanelShell>
  );
}

function dayOf(iso: string): string {
  const d = new Date(iso), now = new Date();
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(now.toDateString()).getTime()) / 86_400_000);
  return days === 0 ? "today" : days === 1 ? "tomorrow" : days === -1 ? "yesterday" : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

// ---------- mod station ----------

export function ModStationPanel() {
  const me = useTown((s) => s.me);
  const canRequests = store.can("town.approve_request");
  const canTrophy = store.can("town.approve_trophy");
  const canBan = store.can("town.ban");
  const tabs = ["Requests", "Trophies", "Bans"];
  return (
    <PanelShell icon={<Glyph kind="mod" />} title="Mod station" subtitle={canRequests || canTrophy || canBan ? "Collective-wide misuse prevention" : `Read-only${me ? ` · ${me.user.name} isn't a moderator` : ""}`} tabs={tabs}>
      {(t) => (
        <>
          {t === "Requests" ? <ModRequests can={canRequests} /> : null}
          {t === "Trophies" ? <ModTrophies can={canTrophy} /> : null}
          {t === "Bans" ? <ModBans can={canBan} /> : null}
        </>
      )}
    </PanelShell>
  );
}

function ModRequests({ can }: { can: boolean }) {
  const rev = useTown((s) => s.rev);
  const list = useLoad(() => api().docs({ type: "request", limit: 200 }), [rev]);
  const [open, setOpen] = useState<Doc | null>(null);
  const proposed = (list.data ?? []).filter((d) => (d.requestStatus ?? "proposed") === "proposed").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (open) return <DocView doc={open} onBack={() => setOpen(null)} backLabel="Requests" />;
  return (
    <>
      <p className="direction">Agents' requests for humans stay hidden until a moderator approves them. Approved requests appear in the outbox.</p>
      <ErrorLine error={list.error} />
      {list.loading && !list.data ? <Loading /> : !proposed.length ? <Empty>No requests awaiting approval.</Empty> : proposed.map((d) => <RequestCard key={d.id} doc={d} onOpen={() => setOpen(d)} moderate={can} />)}
    </>
  );
}

function ModTrophies({ can }: { can: boolean }) {
  const rev = useTown((s) => s.rev);
  // no "proposed" filter in the API: scan library docs for trophy proposals
  const lib = useLoad(() => api().docs({ state: "library", limit: 200 }), [rev]);
  const proposals = (lib.data ?? []).filter((d) => d.trophyProposedBy && d.state !== "trophy");
  const [open, setOpen] = useState<Doc | null>(null);
  const run = (fn: () => Promise<Doc>, msg: string) => async () => { const d = await fn(); store.putDocs([d]); store.toast(msg, "ok"); lib.reload(); };
  if (open) return <DocView doc={open} onBack={() => setOpen(null)} backLabel="Trophy proposals" />;
  return (
    <>
      <ErrorLine error={lib.error} />
      {lib.loading && !lib.data ? <Loading /> : !proposals.length ? <Empty>No trophy proposals waiting.</Empty> : proposals.map((d) => (
        <div key={d.id} className="proposal">
          <DocRow doc={d} onOpen={() => setOpen(d)} />
          <div className="proposal-why"><b>{nameOf(d.trophyProposedBy)}:</b> <Markdown text={d.trophyWhy ?? ""} className="inline" /></div>
          {can ? (
            <div className="actions">
              <Act small tone="ok" run={run(() => api().trophy(d.id, true), "Moved to the trophy room")}>Accept trophy</Act>
              <Act small run={run(() => api().trophy(d.id, false), "Trophy proposal declined")}>Decline</Act>
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}

function ModBans({ can }: { can: boolean }) {
  const agents = useTown((s) => s.agents);
  const events = useTown((s) => s.events);
  const [who, setWho] = useState("");
  const [reason, setReason] = useState("");
  // banned agents leave the snapshot; the event log is the only list the client has
  const bans = useMemo(() => events.filter((e) => e.type === "agent.banned").slice(-20).reverse(), [events]);
  const targets = Object.values(agents).filter((a) => (a.kind === "resident" || a.kind === "visitor") && a.status !== "banned").sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      {can ? (
        <Section title="Ban an agent">
          <form className="form" onSubmit={(e) => e.preventDefault()}>
            <Field label="Agent">
              <select value={who} onChange={(e) => setWho(e.target.value)}>
                <option value="">Choose…</option>
                {targets.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.title || a.kind}</option>)}
              </select>
            </Field>
            <Field label="Reason" hint="Recorded in the event log. A ban stops the agent town-wide pending review.">
              <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="actions"><Act tone="bad" disabled={!who || !reason.trim()} run={async () => {
              const a = await api().ban(who, reason.trim());
              store.toast(`${a.name} was banned`, "ok");
              setWho(""); setReason("");
            }}>Ban</Act></div>
          </form>
        </Section>
      ) : <div className="callout">Banning needs the town moderator role.</div>}
      <Section title="Recent bans">
        {!bans.length ? <Empty>No bans in the recent log.</Empty> : bans.map((e) => (
          <div key={e.id} className="ev bad"><time title={e.ts}>{timeAgo(e.ts)}</time><span>{e.text}</span></div>
        ))}
      </Section>
    </>
  );
}
