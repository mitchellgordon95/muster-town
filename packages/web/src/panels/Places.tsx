/**
 * Panels that belong to places on the map: the in-tray (manager's desk), the building board,
 * the filing cabinet, the schedule board and the mod station (Town Hall). Donating is at the Bank (BankFunding.tsx).
 */
import { useEffect, useMemo, useState } from "react";
import { BOARD_TYPES, DocType, type Doc, type GrantView, type Meeting } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown, roleOf } from "../state";
import { DocRow, DocView, VERDICT_TONE, needOf } from "./DocView";
import { Glyph, PanelShell } from "./PanelShell";
import { phaseTone } from "./BuildingPanel";
import { RequestCard } from "./OutboxPanel";
import { Markdown } from "./Markdown";
import { Act, Empty, ErrorLine, Field, Loading, Pill, Section, clock, fmtTokens, nameOf, timeAgo, usd, useLoad } from "./ui";
import { portraitUrl } from "../map/sprites";

// ---------- in-tray ----------

export function IntrayPanel({ buildingId }: { buildingId: string }) {
  const b = useTown((s) => s.buildings.find((x) => x.id === buildingId));
  const agents = useTown((s) => s.agents);
  const rev = useTown((s) => s.rev);
  useTown((s) => s.me);
  // refetch whenever the count on the building changes (WS `building`) or any doc arrives
  const list = useLoad(() => api().intray(buildingId), [buildingId, b?.intray, rev]);
  const [openId, setOpenId] = useState<string | null>(null);
  const canReview = store.can("building.review", buildingId);
  const reports = useMemo(() => [...(list.data?.reports ?? [])].sort((x, y) => x.createdAt.localeCompare(y.createdAt)), [list.data]);
  const grants = list.data?.grants ?? [];
  useEffect(() => { if (list.data) store.putDocs(list.data.reports); }, [list.data]);
  const stored = useTown((s) => (openId ? s.docs[openId] : undefined));
  const open = openId ? reports.find((d) => d.id === openId) ?? stored ?? null : null;
  // covered reports and checkpoint reports may not be loaded yet
  const openDoc = (id: string) => { setOpenId(id); if (!store.state.docs[id]) void api().doc(id).then((d) => store.putDocs([d])).catch((e: Error) => store.toast(e.message, "bad")); };
  if (!b) return <PanelShell title="In-tray"><Empty>No building with id {buildingId}.</Empty></PanelShell>;
  const hall = b.kind === "town-hall";
  const manager = b.managerAgentId ? agents[b.managerAgentId] : undefined;
  const subtitle = hall ? "Town Hall · rollups, proposals and checkpoints for the humans" : `${b.name} · manager's desk · worked by ${manager ? `★ ${manager.name}` : "you"}`;
  const count = reports.length + grants.length;
  return (
    <PanelShell icon={<Glyph kind="intray" />} title={<>In-tray {count ? <Pill tone="warn">{count}</Pill> : null}</>} subtitle={subtitle}>
      {open ? (
        <DocView doc={open} review onBack={() => setOpenId(null)} backLabel="In-tray" onDecided={() => { setOpenId(null); list.reload(); }} />
      ) : (
        <>
          {!canReview && !hall ? <div className="callout">You can read the in-tray. Decisions are for the building's manager and reviewer.</div> : null}
          {manager && !hall ? <div className="callout">★ {manager.name}, the building's manager, works this in-tray and rolls up to the Town Hall in-tray. You can still decide here.</div> : null}
          <ErrorLine error={list.error} />
          {list.loading && !list.data ? <Loading /> : hall ? (
            <TownHallIntray reports={reports} grants={grants} onOpen={openDoc} onDecided={list.reload} />
          ) : !reports.length ? <Empty>The in-tray is empty. When a resident finishes a session, its report lands here and the resident goes idle.</Empty> : (
            <div className="doc-list">
              {reports.map((d) => <IntrayRow key={d.id} doc={d} onOpen={() => setOpenId(d.id)} />)}
            </div>
          )}
        </>
      )}
    </PanelShell>
  );
}

/**
 * The Town Hall in-tray (docs/waterfall.md §3.5): every building's pending manager reports (rollups expand to the
 * reports they cover), then the grants a human must decide: proposals (Fund / Counter / Reject) and checkpoints
 * (Continue / Adjust / Cut). Countered proposals wait on the manager and are shown without buttons.
 */
function TownHallIntray({ reports, grants, onOpen, onDecided }: { reports: Doc[]; grants: GrantView[]; onOpen: (id: string) => void; onDecided: () => void }) {
  const proposals = grants.filter((g) => g.status === "proposed" || g.status === "countered");
  const checkpoints = grants.filter((g) => g.status === "checkpoint");
  if (!reports.length && !grants.length) return <Empty>The Town Hall in-tray is empty. Managers' rollups, checkpoint reports and escalations land here, with the grant proposals and checkpoints waiting for a human.</Empty>;
  return (
    <>
      {reports.length ? (
        <Section title={<>Manager reports <Pill>{reports.length}</Pill></>}>
          <div className="doc-list">{reports.map((d) => <IntrayRow key={d.id} doc={d} onOpen={() => onOpen(d.id)} onOpenDoc={onOpen} showBuilding />)}</div>
        </Section>
      ) : null}
      {proposals.length ? (
        <Section title={<>Proposals <Pill>{proposals.length}</Pill></>}>
          <div className="doc-list">{proposals.map((g) => <GrantRow key={g.id} grant={g} onDecided={onDecided} onOpenDoc={onOpen} />)}</div>
        </Section>
      ) : null}
      {checkpoints.length ? (
        <Section title={<>Checkpoints <Pill>{checkpoints.length}</Pill></>}>
          <div className="doc-list">{checkpoints.map((g) => <GrantRow key={g.id} grant={g} onDecided={onDecided} onOpenDoc={onOpen} />)}</div>
        </Section>
      ) : null}
    </>
  );
}

/** A building's name with the building glyph, for rows in the Town Hall in-tray. */
function BuildingTag({ buildingId }: { buildingId: string | null }) {
  const b = useTown((s) => s.buildings.find((x) => x.id === buildingId));
  return <span className="intray-building"><Glyph kind="building" />{b?.name ?? buildingId ?? "Town"}</span>;
}

/** A proposal or checkpoint row with its decision controls (POST /api/grants/:id/decide, `building.fund`). */
function GrantRow({ grant: g, onDecided, onOpenDoc }: { grant: GrantView; onDecided: () => void; onOpenDoc: (id: string) => void }) {
  useTown((s) => s.me);
  const manager = useTown((s) => { const b = s.buildings.find((x) => x.id === g.buildingId); return b?.managerAgentId ? s.agents[b.managerAgentId] : undefined; });
  const author = useTown((s) => s.agents[g.proposedBy]);
  const checkpoint = g.status === "checkpoint";
  const ceiling = checkpoint ? g.grantTokens ?? g.askTokens : g.askTokens;
  const [tokens, setTokens] = useState(String(ceiling));
  const [note, setNote] = useState("");
  const canFund = store.can("building.fund", g.buildingId);
  const last = g.history[g.history.length - 1];
  const n = Number(tokens.replace(/[,_\s]/g, ""));
  const tokensOk = Number.isInteger(n) && n > 0;
  const decide = (action: "fund" | "counter" | "reject" | "continue" | "adjust" | "cut", msg: string) => async () => {
    const withTokens = action === "fund" || action === "adjust" || (action === "counter" && n !== g.askTokens);
    await api().decideGrant(g.id, { action, note, ...(withTokens && tokensOk ? { tokens: n } : {}) });
    store.toast(msg, "ok");
    onDecided();
  };
  const pct = g.grantTokens ? Math.min(100, Math.round((g.spentTokens / g.grantTokens) * 100)) : 0;
  return (
    <div className="doc-row intray-row grant-row">
      <div className="intray-who">
        <BuildingTag buildingId={g.buildingId} />
        {author ? <img src={portraitUrl(author.sprite, 1)} alt="" /> : null}<b>{manager ? `★ ${manager.name}` : nameOf(g.proposedBy)}</b>
        <span>{timeAgo(g.updatedAt)}</span>
        <Pill tone={checkpoint ? "warn" : g.status === "countered" ? "" : "ok"}>{g.status}</Pill>
      </div>
      <div className="doc-row-title">{g.objective}</div>
      <div className="doc-row-meta">
        {checkpoint
          ? <span>{fmtTokens(g.spentTokens)} of {fmtTokens(g.grantTokens ?? 0)} tokens spent ({pct}%)</span>
          : <span>asks {fmtTokens(g.askTokens)} tokens</span>}
        {g.checkpointDocId ? <button className="link" onClick={() => onOpenDoc(g.checkpointDocId!)}>checkpoint report</button> : null}
      </div>
      <ul className="grant-krs">
        {g.keyResults.map((k) => <li key={k.id}>{k.text} <span className="muted">· {k.status.replace(/-/g, " ")}</span></li>)}
      </ul>
      <div className="intray-proposal">Stop when: {g.stopCondition}</div>
      {last?.note ? <div className="intray-proposal">{nameOf(last.byId)} ({last.action}): {last.note}</div> : null}
      {g.status === "countered" ? (
        <div className="muted">Countered: waiting for {manager ? `★ ${manager.name}` : "the manager"} to revise and propose again.</div>
      ) : !canFund ? (
        <div className="muted">Funding decisions are for humans with building.fund.</div>
      ) : (
        <div className="grant-decide">
          <div className="grant-inputs">
            <Field label={checkpoint ? "Grant (tokens)" : "Tokens"}><input value={tokens} inputMode="numeric" onChange={(e) => setTokens(e.target.value)} /></Field>
            <Field label="Note"><input value={note} placeholder={checkpoint ? "optional" : "required to counter"} onChange={(e) => setNote(e.target.value)} /></Field>
          </div>
          <div className="actions">
            {checkpoint ? <>
              <Act small tone="ok" run={decide("continue", "Grant continued")}>Continue</Act>
              <Act small disabled={!tokensOk} run={decide("adjust", "Grant adjusted")} title="Set the grant to the token field">Adjust</Act>
              <Act small tone="bad" run={decide("cut", "Grant cut")}>Cut</Act>
            </> : <>
              <Act small tone="ok" disabled={!tokensOk} run={decide("fund", `Funded ${tokensOk ? fmtTokens(n) : ""} tokens`)}>Fund</Act>
              <Act small disabled={!note.trim()} run={decide("counter", "Countered: back to the manager")} title="Send it back with the note (and the token field, if changed)">Counter</Act>
              <Act small tone="bad" run={decide("reject", "Proposal rejected")}>Reject</Act>
            </>}
          </div>
        </div>
      )}
    </div>
  );
}

function IntrayRow({ doc, onOpen, onOpenDoc, showBuilding }: { doc: Doc; onOpen: () => void; onOpenDoc?: (id: string) => void; showBuilding?: boolean }) {
  const a = useTown((s) => s.agents[doc.authorId]);
  const need = needOf(doc.body);
  const rollup = doc.tags.includes("rollup");
  const covered = doc.provenance.sourceIds;
  const [expanded, setExpanded] = useState(false);
  const docs = useTown((s) => s.docs);
  useEffect(() => {
    if (!expanded) return;
    const missing = covered.filter((id) => !store.state.docs[id]);
    if (missing.length) void Promise.all(missing.map((id) => api().doc(id).catch(() => null))).then((ds) => store.putDocs(ds.filter((d): d is Doc => !!d)));
  }, [expanded]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="intray-item">
      <button className="doc-row intray-row" onClick={onOpen}>
        <div className="intray-who">
          {showBuilding ? <BuildingTag buildingId={doc.buildingId} /> : null}
          {a ? <img src={portraitUrl(a.sprite, 1)} alt="" /> : null}<b>{nameOf(doc.authorId)}</b><span>{timeAgo(doc.createdAt)}</span>
          {rollup ? <Pill tone="ok">rollup</Pill> : null}
        </div>
        <div className="doc-row-title">{doc.title}</div>
        {need ? <div className="intray-proposal">Needs: {need.length > 140 ? need.slice(0, 140) + "…" : need}</div> : null}
        <div className="doc-row-meta">
          {doc.verdict ? <Pill tone={VERDICT_TONE[doc.verdict]}>verdict: {doc.verdict}</Pill> : null}
          {doc.tokens ? <span>{fmtTokens(doc.tokens)} tokens{doc.costUsd ? ` · ${usd(doc.costUsd)}` : ""}</span> : null}
        </div>
      </button>
      {rollup && covered.length ? (
        <div className="intray-covered">
          <button className="link" onClick={() => setExpanded(!expanded)}>{expanded ? "▾" : "▸"} covers {covered.length} report{covered.length === 1 ? "" : "s"}</button>
          {expanded ? (
            <ul>
              {covered.map((id) => {
                const d = docs[id];
                return <li key={id}><button className="link" onClick={() => onOpenDoc?.(id)}>{d ? `${nameOf(d.authorId)}: ${d.title}` : id}</button>{d?.decision ? <span className="muted"> · {d.decision}</span> : null}</li>;
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------- board ----------

export function BoardPanel({ buildingId }: { buildingId: string }) {
  const b = useTown((s) => s.buildings.find((x) => x.id === buildingId));
  return (
    <PanelShell icon={<Glyph kind="board" />} title={`${b?.name ?? "Building"} board`} subtitle="The manager's standing rules and building-wide FYIs. Everything else is in the filing cabinet beside it.">
      {b ? <StandingRules buildingId={b.id} rules={b.rules ?? ""} /> : null}
      <DocList buildingId={buildingId} />
    </PanelShell>
  );
}

// ---------- filing cabinet ----------

export function CabinetPanel({ buildingId }: { buildingId: string }) {
  const b = useTown((s) => s.buildings.find((x) => x.id === buildingId));
  return (
    <PanelShell icon={<Glyph kind="cabinet" />} title={`${b?.name ?? "Building"} filing cabinet`} subtitle="Everything published in this building that isn't a board FYI, in a folder per doc type, newest first.">
      <CabinetBrowser buildingId={buildingId} />
    </PanelShell>
  );
}

const FOLDER_TYPES = DocType.options.filter((t) => !BOARD_TYPES.includes(t));
const FOLDER_LIMIT = 200;
const FOLDER_NAMES: Partial<Record<DocType, string>> = { "meeting-notes": "Meeting notes", "human-report": "Human reports", "assignment-proposal": "Assignment proposals" };
const folderName = (t: DocType) => FOLDER_NAMES[t] ?? `${t[0].toUpperCase()}${t.slice(1)}s`;

/** The filing cabinet as a file browser: folders by doc type with counts, an author filter, docs newest first. */
function CabinetBrowser({ buildingId }: { buildingId: string }) {
  const rev = useTown((s) => s.rev);
  const [authorId, setAuthorId] = useState("");
  const [folder, setFolder] = useState<DocType | null>(null);
  const [open, setOpen] = useState<Doc | null>(null);
  const list = useLoad(() => api().cabinet(buildingId, folder ? { type: folder, authorId, limit: FOLDER_LIMIT } : { limit: 1 }), [buildingId, folder, authorId, rev]);
  useEffect(() => { if (list.data) store.putDocs(list.data.docs); }, [list.data]);
  const counts = list.data?.counts ?? [];
  const authors = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of counts) m.set(c.authorId, (m.get(c.authorId) ?? 0) + c.n);
    return [...m].map(([id, n]) => ({ id, n, name: nameOf(id) })).sort((a, b) => a.name.localeCompare(b.name));
  }, [counts]);
  const count = (t: DocType) => counts.filter((c) => c.type === t && (!authorId || c.authorId === authorId)).reduce((s, c) => s + c.n, 0);
  const folders = FOLDER_TYPES.map((t) => ({ type: t, n: count(t) })).filter((f) => f.n > 0);
  if (open) return <DocView doc={open} onBack={() => setOpen(null)} backLabel={folder ? folderName(folder) : "Filing cabinet"} />;
  return (
    <>
      <div className="cabinet-bar">
        {folder ? <button className="link" onClick={() => setFolder(null)}>← Filing cabinet</button> : <b>Folders</b>}
        {folder ? <b>/ {folderName(folder)}</b> : null}
        <select value={authorId} onChange={(e) => setAuthorId(e.target.value)} aria-label="Author">
          <option value="">All authors ({authors.reduce((s, a) => s + a.n, 0)})</option>
          {authors.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.n})</option>)}
        </select>
      </div>
      <ErrorLine error={list.error} />
      {list.loading && !list.data ? <Loading /> : !folder ? (
        !folders.length ? <Empty>{authorId ? `${nameOf(authorId)} hasn't filed anything here.` : "Nothing filed yet."}</Empty> : (
          <div className="folders">
            {folders.map((f) => (
              <button key={f.type} className="folder" onClick={() => setFolder(f.type)}>
                <span className="folder-icon" aria-hidden>▤</span>
                <span className="folder-name">{folderName(f.type)}</span>
                <span className="folder-n">{f.n}</span>
              </button>
            ))}
          </div>
        )
      ) : !list.data?.docs.length ? <Empty>This folder is empty{authorId ? ` for ${nameOf(authorId)}` : ""}.</Empty> : (
        <>
          <div className="doc-list">{list.data.docs.map((d) => <DocRow key={d.id} doc={d} onOpen={() => setOpen(d)} />)}</div>
          {count(folder) > list.data.docs.length ? <p className="muted">Showing the newest {list.data.docs.length} of {count(folder)}.</p> : null}
        </>
      )}
    </>
  );
}

/** Board FYIs, newest first. */
function DocList({ buildingId }: { buildingId: string }) {
  const rev = useTown((s) => s.rev);
  const list = useLoad(() => api().board(buildingId, 50), [buildingId, rev]);
  const [open, setOpen] = useState<Doc | null>(null);
  useEffect(() => { if (list.data) store.putDocs(list.data); }, [list.data]);
  if (open) return <DocView doc={open} onBack={() => setOpen(null)} backLabel="Board" />;
  return (
    <>
      <ErrorLine error={list.error} />
      {list.loading && !list.data ? <Loading /> : !list.data?.length ? <Empty>No FYIs on the board.</Empty> : (
        <div className="doc-list">{list.data.map((d) => <DocRow key={d.id} doc={d} onOpen={() => setOpen(d)} />)}</div>
      )}
    </>
  );
}

/** Pinned at the top of the board: the manager's standing rules, added to every session's brief in this building. */
function StandingRules({ buildingId, rules }: { buildingId: string; rules: string }) {
  const canEdit = store.can("building.manage", buildingId);
  const [draft, setDraft] = useState<string | null>(null);
  if (!rules.trim() && !canEdit) return null;
  return (
    <div className="rules-card">
      <div className="rules-head">
        <b>Standing rules</b>
        <span>every agent reads these when a session starts here</span>
        {canEdit && draft === null ? <button className="link" onClick={() => setDraft(rules)}>{rules.trim() ? "Edit" : "Add rules"}</button> : null}
      </div>
      {draft !== null ? (
        <form className="form" onSubmit={(e) => e.preventDefault()}>
          <textarea rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={"- One small PR per session.\n- Mention @Name when you need a decision."} autoFocus />
          <div className="actions">
            <Act tone="primary" run={async () => {
              await api().updateBuilding(buildingId, { rules: draft });
              setDraft(null);
              store.toast("Standing rules saved; they apply from the next session", "ok");
            }}>Save rules</Act>
            <button type="button" className="btn" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </form>
      ) : rules.trim() ? <Markdown text={rules} /> : <div className="muted">No standing rules yet. Add some and every session in this building starts with them.</div>}
    </div>
  );
}

// ---------- schedule board ----------

/** Walk to the meeting's room, then open it. */
export function joinMeeting(m: Meeting) {
  const hall = store.state.buildings.find((b) => b.kind === "town-hall");
  const room = `meeting-room:${m.buildingId ?? hall?.id ?? ""}`;
  if (m.kind === "one-on-one") return store.open({ kind: "meeting", id: m.id });
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
                {targets.map((a) => <option key={a.id} value={a.id}>{a.name} · {roleOf(a) || a.kind}</option>)}
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
