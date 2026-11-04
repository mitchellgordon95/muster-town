/**
 * Panels that belong to places on the map: the in-tray (manager's desk), the building board,
 * the filing cabinet, the schedule board and the mod station (Town Hall). Donating is at the Bank (BankFunding.tsx).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BOARD_TYPES, DocType, askVerb, estimateRangeOf, type AccessRequestView, type RollupAsk, type CaptainRequestView, type CheckpointEvidence, type Doc, evidenceKrLine, grantStopOf, topUpLine, type GrantStop, type ScheduleView, type FunderWeek, type GrantView, type IntrayRoute, type Meeting, type DigestCard, historyActor, historyNote } from "@muster-town/schema";
import { api, type Board, type GoalProposalView, type Intray, type ReportChain } from "../api";
import { forkTip } from "../forks";
import { UNBLOCK_LINE, unfundableReason } from "./keyResults";
import { store, useTown, roleOf } from "../state";
import { DocRow, DocView, VERDICT_TONE, needOf } from "./DocView";
import { Glyph, PanelShell } from "./PanelShell";
import { phaseTone } from "./room";
import { RequestCard } from "./OutboxPanel";
import { DocText, Markdown } from "./Markdown";
import { grantUrl } from "../route";
import { ADJ, ADJ_HINT, Act, Empty, ErrorLine, Field, Loading, MTokensInput, Pill, Section, breakdownTitle, clock, fmtTokens, nameOf, timeAgo, usd, useLoad } from "./ui";
import { fromMillions, toMillions } from "../format";
import { portraitUrl } from "../map/sprites";
import { useMediaPaste } from "./mediaPaste";
import { MediaThumb } from "./MediaThumb";
import { clipText } from "./showMore";
import { canOneOnOne, canTalkAtTownHall, grantTalkTarget, openOneOnOne, secretaryOf } from "./oneOnOne";
import { decideJoin, letInGoal } from "./letIn";
import { RollupCards, rollupCardsOf } from "./RollupCards";
import { ReviewDeckView } from "./ReviewDeck";
import { fundedOnly, isFunder, type IntrayView } from "./funderFilter";
import { GoalProposalItem } from "./GoalTreePanel";
import { CompactLine, IntrayModeToggle, accessTitle, captainTitle, goalProposalTitle, grantPill, readIntrayMode, reportPill, retainerPill, saveIntrayMode, type IntrayMode } from "./intrayList";

/** The Town Hall in-tray's "Mine / All" (docs/goals.md step 4): under Mine, only the items routed to the viewer. */
export function mineOnly<T extends { id: string }>(items: T[], routes: Record<string, IntrayRoute>, view: IntrayView, funder?: FunderWeek | null): T[] {
  if (view === "funded") return funder ? fundedOnly(items, routes, funder) : items;
  return view === "all" ? items : items.filter((x) => routes[x.id]?.mine);
}

// ---------- in-tray ----------

export function IntrayPanel({ buildingId }: { buildingId: string }) {
  const b = useTown((s) => s.buildings.find((x) => x.id === buildingId));
  const agents = useTown((s) => s.agents);
  const rev = useTown((s) => s.rev);
  useTown((s) => s.me);
  // refetch whenever the count on the building changes (WS `building`) or any doc arrives
  const list = useLoad(() => api().intray(buildingId), [buildingId, b?.intray, rev]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [asDeck, setAsDeck] = useState(false);
  const [viewPick, setView] = useState<IntrayView | null>(null);
  // List (one line per item, the default) or Cards (the full rows), remembered (Mitchell's flag dc_2hllscunfx)
  const [mode, setModeState] = useState<IntrayMode>(readIntrayMode);
  const setMode = (m: IntrayMode) => { saveIntrayMode(m); setModeState(m); };
  // a line opened in List mode that isn't a report: its full row, with its decision buttons
  const [focus, setFocus] = useState<Focus | null>(null);
  const signedIn = useTown((s) => !!s.me);
  const canReview = store.can("building.review", buildingId);
  const routes = list.data?.routes ?? {};
  const isHall = b?.kind === "town-hall";
  // the funder filter (goal tree step 8): only a signed-in human with a Bank input gets "Funded by me"
  const funderLoad = useLoad(() => signedIn && isHall ? api().funderWeek().catch(() => null) : Promise.resolve(null), [signedIn, isHall, b?.intray]);
  const funder = isFunder(funderLoad.data) ? funderLoad.data : null;
  const picked = viewPick === "funded" && !funder ? null : viewPick;
  const view = signedIn && isHall ? picked ?? list.data?.defaultView ?? "all" : "all";
  const allReports = useMemo(() => [...(list.data?.reports ?? [])].sort((x, y) => x.createdAt.localeCompare(y.createdAt)), [list.data]);
  const reports = isHall ? mineOnly(allReports, routes, view, funder) : allReports;
  const grants = mineOnly(list.data?.grants ?? [], routes, view, funder);
  const goalProposals = mineOnly(list.data?.goalProposals ?? [], routes, view, funder);
  const captains = mineOnly(list.data?.captains ?? [], routes, view, funder);
  const retainers = mineOnly(list.data?.retainers ?? [], routes, view, funder);
  // grants a human stopped: shown, never counted (nothing to decide)
  const stopped = mineOnly(list.data?.stopped ?? [], routes, view, funder);
  const hidden = isHall ? allReports.length + (list.data?.grants?.length ?? 0) + (list.data?.goalProposals?.length ?? 0) + (list.data?.captains?.length ?? 0) + (list.data?.retainers?.length ?? 0) - reports.length - grants.length - goalProposals.length - captains.length - retainers.length : 0;
  useEffect(() => { if (list.data) store.putDocs(list.data.reports); }, [list.data]);
  const stored = useTown((s) => (openId ? s.docs[openId] : undefined));
  const open = openId ? reports.find((d) => d.id === openId) ?? stored ?? null : null;
  // covered reports and checkpoint reports may not be loaded yet
  const openDoc = (id: string) => { setOpenId(id); if (!store.state.docs[id]) void api().doc(id).then((d) => store.putDocs([d])).catch((e: Error) => store.toast(e.message, "bad")); };
  if (!b) return <PanelShell title="In-tray"><Empty>No building with id {buildingId}.</Empty></PanelShell>;
  const hall = b.kind === "town-hall";
  const manager = b.managerAgentId ? agents[b.managerAgentId] : undefined;
  const subtitle = hall ? "Town Hall · rollups, proposals and checkpoints for the humans" : `${b.name} · manager's desk · worked by ${manager ? `★ ${manager.name}` : "you"}`;
  const flags = reports.filter((d) => d.type === "flag").length;
  const access = list.data?.access ?? [];
  const focused = focus && !open ? focusRow(focus, { grants: [...grants, ...stopped], retainers, captains, access, goalProposals }, routes, { onDecided: () => { setFocus(null); list.reload(); }, onMarked: list.reload, onOpenDoc: openDoc }) : null;
  const toggle = <IntrayModeToggle mode={mode} set={setMode} />;
  const count = reports.length + grants.length + goalProposals.length + access.length + captains.length + retainers.filter((x) => x.retainer === "asked").length - flags;
  return (
    <PanelShell icon={<Glyph kind="intray" />} title={<>In-tray {count ? <Pill tone="warn" title="Reports, rollups and proposals waiting">{count}</Pill> : null}{flags ? <> <Pill tone="warn" title="Flags humans planted here, waiting for the manager to delegate">⚑ {flags}</Pill></> : null}</>} subtitle={subtitle}>
      {open ? (
        <DocView doc={open} review onBack={() => setOpenId(null)} backLabel={asDeck ? "Review deck" : "In-tray"} onDecided={() => { setOpenId(null); list.reload(); }} />
      ) : focused ? (
        <div className="intray-focus">
          <button className="btn sm" onClick={() => setFocus(null)}>← In-tray</button>
          {focused}
        </div>
      ) : hall && asDeck ? (
        <ReviewDeckView grants={[...grants, ...stopped]} reports={reports} goalProposals={goalProposals} captains={captains} retainers={retainers} view={view} funder={funder} onClose={() => setAsDeck(false)} onDecided={list.reload} onOpenDoc={openDoc} />
      ) : (
        <>
          {!canReview && !hall ? <div className="callout">You can read the in-tray. Decisions are for the building's manager.</div> : null}
          {manager && !hall ? <div className="callout">★ {manager.name}, the building's manager, works this in-tray and rolls up to the Town Hall in-tray. You can still decide here.</div> : null}
          {hall ? <ReviewAsDeckButton count={count} onOpen={() => setAsDeck(true)} view={signedIn ? { view, hidden, set: setView, funder: !!funder } : undefined} layout={toggle} /> : <div className="intray-head actions">{toggle}</div>}
          <ErrorLine error={list.error} />
          {list.loading && !list.data ? <Loading /> : hall ? (
            <TownHallIntray digest={list.data?.digest ?? null} mode={mode} onFocus={setFocus} reports={reports} grants={grants} goalProposals={goalProposals} routes={routes} access={access} captains={captains} retainers={retainers} blocked={list.data?.blocked ?? []} stopped={stopped} onOpen={openDoc} onDecided={list.reload} />
          ) : !reports.length ? <Empty>The in-tray is empty. When the manager or a fork finishes a session, its report lands here and that agent goes idle; a flag you plant (F on the map) lands here too.</Empty> : (
            <div className="doc-list">
              {reports.map((d) => mode === "list"
                ? <CompactLine key={d.id} lead={<ReportLead doc={d} forkOf={list.data?.chains?.[d.id]?.forkOf} />} title={d.title} at={d.createdAt} pill={reportPill(d)} onOpen={() => setOpenId(d.id)} />
                : <IntrayRow key={d.id} doc={d} chain={list.data?.chains?.[d.id]} onOpen={() => setOpenId(d.id)} onOpenDoc={openDoc} />)}
            </div>
          )}
        </>
      )}
    </PanelShell>
  );
}

/** "Talk to Secretary" (gr_kdlogzzo5s): opens my 1:1 with the Town Hall's Secretary; nothing without a live Secretary or the Planner's permission. */
export function TalkToSecretary() {
  const hallId = useTown((s) => s.buildings.find((b) => b.kind === "town-hall")?.id);
  const secretary = useTown((s) => secretaryOf(s.agents, hallId));
  const me = useTown((s) => s.me);
  if (!hallId || !secretary || !me || !canTalkAtTownHall(hallId)) return null;
  return <Act small run={() => openOneOnOne(hallId, { agentId: secretary.id })} title={`A 1:1 with ${secretary.name}: say a decision in your own words and it is done as yours`}>Talk to {secretary.name}</Act>;
}

/** The Town Hall in-tray header's "Review as deck": the in-tray as slides (design dc_y7a8g257of §2). */
export function ReviewAsDeckButton({ count, onOpen, view, layout }: { count: number; onOpen: () => void; view?: { view: IntrayView; hidden: number; set: (v: IntrayView) => void; funder?: boolean }; layout?: ReactNode }) {
  return (
    <div className="intray-head actions">
      <button className="btn sm primary" onClick={onOpen} title="One slide per pending decision, blocking-most first, with the decision buttons on each slide (← → to move)">▶ Review as deck</button>
      <TalkToSecretary />
      <span className="muted">{view?.view === "funded" ? `${count} under the goals your money reached: slide 1 is your week as a funder` : count ? `${count} waiting: slide 1 is the state of the town` : "slide 1 is the state of the town"}</span>
      {view ? (
        <span className="intray-view" role="group" aria-label="Show">
          <button className={`btn sm ${view.view === "mine" ? "primary" : ""}`} onClick={() => view.set("mine")} title="Items routed to you: the goals you captain and everything under them">Mine</button>
          <button className={`btn sm ${view.view === "all" ? "primary" : ""}`} onClick={() => view.set("all")} title="Everything waiting in the Town Hall">All</button>
          {view.funder ? <button className={`btn sm ${view.view === "funded" ? "primary" : ""}`} onClick={() => view.set("funded")} title="What your Bank inputs paid for this week, and the items under the goals your money reached">Funded by me</button> : null}
          {view.view !== "all" && view.hidden ? <span className="muted">{view.hidden} more under All</span> : null}
        </span>
      ) : null}
      {layout}
    </div>
  );
}

/**
 * Plant a flag (town hall 2026-10-25 evening, decision 3): a short note a human writes, picking the building; it lands
 * in that building's in-tray as a pending `flag` for the manager to delegate. Opened with F on the map (Mitchell's flag
 * dc_7qng5lccew), not from an in-tray; `targets` comes from flagTargets, the building I'm standing in first.
 */
export function PlantFlag({ targets, onClose }: { targets: { id: string; name: string; managerAgentId?: string | null }[]; onClose: () => void }) {
  const agents = useTown((s) => s.agents);
  const [buildingId, setBuildingId] = useState(targets[0]?.id ?? "");
  const [text, setText] = useState("");
  const media = useMediaPaste(setText);
  const target = targets.find((t) => t.id === buildingId) ?? targets[0];
  const manager = target?.managerAgentId ? agents[target.managerAgentId] : undefined;
  if (!target) return null;
  const plant = async () => {
    const d = await api().plantFlag(target.id, text.trim());
    store.putDocs([d]);
    store.toast(`Flag planted in ${target.name}${manager ? `; ${manager.name} delegates it` : ""}.`, "ok");
    setText("");
    onClose();
  };
  return (
    <div className="reply-box flag-form" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <div className="flag-head"><b>⚑ Plant a flag</b><span className="muted">a quick request for a building's manager to delegate: no grant, no meeting</span></div>
      {targets.length > 1 ? (
        <Field label="Building">
          <select value={target.id} onChange={(e) => setBuildingId(e.target.value)}>
            {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
      ) : null}
      <textarea {...media.props} rows={3} autoFocus placeholder={`What do you want done in ${target.name}? One quick fix per flag; the first line is its title. Paste or drop a screenshot to show it.`} value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) { e.preventDefault(); void plant().catch((err) => store.toast(String((err as Error).message ?? err), "bad")); } }} />
      <div className="actions">
        <span className="muted">{manager ? `★ ${manager.name} gets it in the ${target.name} in-tray and a fork runs it.` : `${target.name} has no manager agent: whoever works its in-tray assigns it.`}</span>
        <button className="btn sm" onClick={onClose}>Cancel</button>
        <Act small tone="primary" disabled={!text.trim() || media.uploading > 0} run={plant}>Plant</Act>
      </div>
    </div>
  );
}

/**
 * The Town Hall in-tray (docs/waterfall.md §3.5): every building's pending manager reports (rollups expand to the
 * reports they cover), then the grants a human must decide: proposals (Fund / Counter / Reject) and checkpoints
 * (Continue / Adjust / Cut). Countered proposals wait on the manager and are shown without buttons.
 */
function TownHallIntray({ digest, mode, onFocus, reports, grants, goalProposals, routes, access, captains, retainers, blocked, stopped, onOpen, onDecided }: { mode: IntrayMode; onFocus: (f: Focus) => void; reports: Doc[]; grants: GrantView[]; goalProposals: GoalProposalView[]; routes: Record<string, IntrayRoute>; access: AccessRequestView[]; captains: CaptainRequestView[]; retainers: ScheduleView[]; blocked: NonNullable<Intray["blocked"]>; stopped: GrantView[]; onOpen: (id: string) => void; onDecided: () => void; digest?: DigestCard | null }) {
  const digestCard = digest ? <DigestCardView card={digest} onOpen={onOpen} onDecided={onDecided} /> : null;
  const proposals = grants.filter((g) => g.status === "proposed" || g.status === "countered");
  const checkpoints = grants.filter((g) => g.status === "checkpoint");
  // grants a human stopped (gr_8i952perny): for the record, nothing to decide; they leave 3 days after closing
  const stoppedList = stopped.length ? (
    <Section title={<>Stopped: for the record <Pill>{stopped.length}</Pill></>}>
      <div className="doc-list">{stopped.map((g) => list ? grantLine(g, true) : <GrantRow key={g.id} grant={g} route={routes[g.id]} onDecided={onDecided} onOpenDoc={onOpen} />)}</div>
    </Section>
  ) : null;
  const askedOn = askedOnOf(grants, retainers);
  const list = mode === "list";
  const grantLine = (g: GrantView, stoppedOne = false) => <CompactLine key={g.id} lead={<BuildingTag buildingId={g.buildingId} />} title={g.objective} at={g.updatedAt} pill={grantPill(g, stoppedOne)} onOpen={() => onFocus({ kind: "grant", id: g.id })} />;
  // blocked buildings aren't counted in the badge, but they wait on a human all the same
  const blockedList = blocked.length ? (
    <Section title={<>Blocked: no key results <Pill tone="bad">{blocked.length}</Pill></>}>
      <p className="direction">{UNBLOCK_LINE}</p>
      <div className="doc-list">{blocked.map((x) => (
        <div key={x.buildingId} className="doc-row intray-row">
          <div className="intray-who"><BuildingTag buildingId={x.buildingId} />{x.since ? <span>since {timeAgo(x.since)}</span> : null}</div>
          <div className="doc-row-meta">
            <span>{x.reason.replace(/^blocked: /, "")}</span>
            {store.can("building.manage", x.buildingId) ? <button className="link" onClick={() => store.open({ kind: "building", id: x.buildingId, tab: "Goals" })}>Write its key results →</button> : null}
          </div>
        </div>
      ))}</div>
    </Section>
  ) : null;
  const asking = access.length ? (
    <Section title={<>Asking to join <Pill>{access.length}</Pill></>}>
      <div className="doc-list">{access.map((r) => list ? <CompactLine key={r.id} lead={r.avatarUrl ? <img className="intray-avatar" src={r.avatarUrl} alt="" /> : null} title={accessTitle(r)} at={r.createdAt} pill={<Pill tone="warn">join ask</Pill>} onOpen={() => onFocus({ kind: "access", id: r.id })} /> : <AccessRow key={r.id} req={r} onDecided={onDecided} />)}</div>
    </Section>
  ) : null;
  const captainList = captains.length ? (
    <Section title={<>Asking to captain a goal <Pill>{captains.length}</Pill></>}>
      <div className="doc-list">{captains.map((r) => list ? <CompactLine key={r.id} lead={r.avatarUrl ? <img className="intray-avatar" src={r.avatarUrl} alt="" /> : null} title={captainTitle(r)} at={r.createdAt} pill={<Pill tone="warn">captain ask</Pill>} onOpen={() => onFocus({ kind: "captain", id: r.id })} /> : <CaptainRow key={r.id} req={r} route={routes[r.id]} onDecided={onDecided} />)}</div>
    </Section>
  ) : null;
  // retainers: standing money for scheduled jobs (1:1 mt_cyd2t5ioob decision 2), kept apart from grant proposals
  const retainerList = retainers.length ? (
    <Section title={<>Retainers for scheduled jobs <Pill>{retainers.length}</Pill></>}>
      <div className="doc-list">{retainers.map((x) => list ? <CompactLine key={x.id} lead={<BuildingTag buildingId={x.buildingId} />} title={x.title} at={x.updatedAt} pill={retainerPill(x)} onOpen={() => onFocus({ kind: "retainer", id: x.id })} /> : <RetainerRow key={x.id} x={x} route={routes[x.id]} onDecided={onDecided} onOpenDoc={onOpen} />)}</div>
    </Section>
  ) : null;
  const goalList = goalProposals.length ? (
    <Section title={<>Goal proposals <Pill>{goalProposals.length}</Pill></>}>
      {list ? <div className="doc-list">{goalProposals.map((p) => <CompactLine key={p.id} lead={p.buildingId ? <BuildingTag buildingId={p.buildingId} /> : null} title={goalProposalTitle(p)} at={p.createdAt} pill={<Pill>{p.outsideScope ? "outside scope" : "goal"}</Pill>} onOpen={() => onFocus({ kind: "goal", id: p.id })} />)}</div>
        : <div className="goal-proposals">{goalProposals.map((p) => <div key={p.id}><RoutedTo route={routes[p.id]} /><GoalProposalItem p={p} onDone={onDecided} /></div>)}</div>}
    </Section>
  ) : null;
  if (!reports.length && !grants.length && !goalProposals.length) return <>{digestCard}{asking}{captainList}{retainerList}{blockedList}{stoppedList}{digestCard || asking || captainList || retainerList || stoppedList ? null : <Empty>The Town Hall in-tray is empty. Managers' rollups, checkpoint reports, visitor reports and escalations land here, with the grant proposals and checkpoints waiting for a human, and people asking to join or to captain a goal.</Empty>}</>;
  return (
    <>
      {digestCard}
      {asking}
      {captainList}
      {retainerList}
      {blockedList}
      {reports.length ? (
        <Section title={<>Manager reports <Pill>{reports.length}</Pill></>}>
          <div className="doc-list">{reports.map((d) => list
            ? <CompactLine key={d.id} lead={<><BuildingTag buildingId={d.buildingId} /><ReportLead doc={d} /></>} title={d.title} at={d.createdAt} pill={reportPill(d)} onOpen={() => onOpen(d.id)} />
            : <IntrayRow key={d.id} doc={d} onOpen={() => onOpen(d.id)} onOpenDoc={onOpen} showBuilding askedOn={askedOn.get(d.id)} />)}</div>
        </Section>
      ) : null}
      {proposals.length ? (
        <Section title={<>Proposals <Pill>{proposals.length}</Pill></>}>
          <div className="doc-list">{proposals.map((g) => list ? grantLine(g) : <GrantRow key={g.id} grant={g} canDecide={routes[g.id]?.canDecide} route={routes[g.id]} onDecided={onDecided} onOpenDoc={onOpen} />)}</div>
        </Section>
      ) : null}
      {checkpoints.length ? (
        <Section title={<>Checkpoints <Pill>{checkpoints.length}</Pill></>}>
          <div className="doc-list">{checkpoints.map((g) => list ? grantLine(g) : <GrantRow key={g.id} grant={g} canDecide={routes[g.id]?.canDecide} route={routes[g.id]} onDecided={onDecided} onOpenDoc={onOpen} />)}</div>
        </Section>
      ) : null}
      {goalList}
      {stoppedList}
    </>
  );
}

/**
 * The Secretary's digest card (gr_kdlogzzo5s step 3), first in the Town Hall in-tray: what needs a yes or no (read
 * live), what shipped since the last card, and the rollups it covers, collapsed (the ones it archived left the list).
 */
export function DigestCardView({ card: c, onOpen, onDecided }: { card: DigestCard; onOpen: (id: string) => void; onDecided?: () => void }) {
  // "Already overtaken": one Approve-all archives the rollups whose asks the town has since decided (1:1 mt_i50xwu4z2t)
  const approveAll = async (ids: string[]) => {
    const done = await Promise.all(ids.map((id) => api().archive(id)));
    store.putDocs(done.map((r) => r.doc));
    store.toast(`Approved ${ids.length} overtaken rollup${ids.length === 1 ? "" : "s"}.`, "ok");
    onDecided?.();
  };
  return (
    <Section title={<>Digest <Pill>by the Secretary</Pill></>}>
      <div className="doc-row intray-row digest-card">
        <div className="intray-who"><button className="link" onClick={() => onOpen(c.doc.id)}>{c.doc.title}</button><span>{timeAgo(c.doc.createdAt)}</span><TalkToSecretary /></div>
        <b>Decisions needed</b>
        {c.decisions.length ? c.decisions.map((g) => (
          <div className="digest-group" key={g.heading}>
            <div className="digest-group-head"><b>{g.heading}</b>{g.note ? <span className="muted"> {g.note}</span> : null}{g.docIds?.length ? <Act tone="ok" small run={() => approveAll(g.docIds!)} title="Archive these rollups: what they asked has since been decided">Approve all {g.docIds.length}</Act> : null}</div>
            <ul className="digest-decisions">{g.lines.map((l, i) => <li key={i}><DocText text={l} /></li>)}</ul>
          </div>
        )) : <div className="muted">Nothing waits on a yes or no.</div>}
        <b>Shipped since last digest</b>
        {c.shipped ? <Markdown text={c.shipped} /> : <div className="muted">Nothing shipped.</div>}
        {c.covered.length ? (
          <details className="digest-covered">
            <summary>Covered rollups ({c.covered.length})</summary>
            <ul>{c.covered.map((r) => <li key={r.id}><button className="link" onClick={() => onOpen(r.id)}>{r.buildingName}: {r.title}</button> {r.pending ? <Pill tone="warn">still asks a call</Pill> : <span className="muted">archived</span>}</li>)}</ul>
          </details>
        ) : null}
      </div>
    </Section>
  );
}

/** An item opened from a line in List mode (not a report: those open in DocView). */
type Focus = { kind: "grant" | "retainer" | "captain" | "access" | "goal"; id: string };

/** The full row of a focused line, with its decision buttons; null once it left the in-tray (decided). */
function focusRow(f: Focus, items: { grants: GrantView[]; retainers: ScheduleView[]; captains: CaptainRequestView[]; access: AccessRequestView[]; goalProposals: GoalProposalView[] }, routes: Record<string, IntrayRoute>, h: { onDecided: () => void; onMarked: () => void; onOpenDoc: (id: string) => void }): ReactNode {
  const route = routes[f.id];
  switch (f.kind) {
    case "grant": { const g = items.grants.find((x) => x.id === f.id); return g ? <GrantRow grant={g} canDecide={route?.canDecide} route={route} onDecided={h.onDecided} onMarked={h.onMarked} onOpenDoc={h.onOpenDoc} /> : null; }
    case "retainer": { const x = items.retainers.find((y) => y.id === f.id); return x ? <RetainerRow x={x} route={route} onDecided={h.onDecided} onOpenDoc={h.onOpenDoc} /> : null; }
    case "captain": { const r = items.captains.find((y) => y.id === f.id); return r ? <CaptainRow req={r} route={route} onDecided={h.onDecided} /> : null; }
    case "access": { const r = items.access.find((y) => y.id === f.id); return r ? <AccessRow req={r} onDecided={h.onDecided} /> : null; }
    case "goal": { const p = items.goalProposals.find((y) => y.id === f.id); return p ? <div className="goal-proposals"><RoutedTo route={route} /><GoalProposalItem p={p} onDone={h.onDecided} /></div> : null; }
  }
}

/** A report line's author: portrait and name (★ for the building's manager; a retired fork shows its manager's sprite). */
function ReportLead({ doc, forkOf }: { doc: Doc; forkOf?: string | null }) {
  const a = useTown((s) => s.agents[doc.authorId] ?? (forkOf ? s.agents[forkOf] : undefined));
  const isManager = useTown((s) => !!doc.buildingId && s.buildings.some((b) => b.id === doc.buildingId && b.kind !== "town-hall" && b.managerAgentId === doc.authorId));
  const name = isManager ? `★ ${nameOf(doc.authorId)}` : nameOf(doc.authorId);
  return a ? <img src={portraitUrl(a.sprite, 1)} alt={name} title={name} /> : null;
}

/**
 * A rollup's ask on this row (1:1 mt_7b4zc7yja3): "Workshop asks you to fund this: <line>" and a link to the rollup.
 * A rollup that asked nothing else was folded into this row on submit (no card of its own).
 */
function RollupAsks({ asks, verb, onOpenDoc }: { asks?: RollupAsk[]; verb: string; onOpenDoc?: (id: string) => void }) {
  if (!asks?.length) return null;
  return (
    <div className="rollup-asks">
      {asks.map((a) => (
        <div key={a.reportId} className="intray-proposal rollup-ask">
          <b>{a.buildingName} asks you to {verb} this:</b> <DocText text={a.line} />{" "}
          {onOpenDoc ? <button className="link" title={a.title} onClick={() => onOpenDoc(a.reportId)}>{a.folded ? "the rollup" : "the rollup (also in Manager reports)"} →</button> : <span className="muted">({a.reportId})</span>}
        </div>
      ))}
    </div>
  );
}

/** "→ Lena via <goal>": who an in-tray item is routed to (docs/goals.md "Routing"). */
function RoutedTo({ route }: { route?: IntrayRoute }) {
  if (!route) return null;
  return <div className="muted intray-route" title={`Routed by goal ${route.goalId}`}>For {route.mine ? <b>you</b> : route.ownerName}{route.canDecide && !route.mine ? " (you can decide it too)" : ""}</div>;
}

/**
 * Someone signed in with GitHub asks to join (dc_f0cumcfubk). Let in grants the town `member` role (they can move,
 * talk, message agents and write); Decline leaves them read-only, and they may ask again after a day.
 */
export function AccessRow({ req, onDecided }: { req: AccessRequestView; onDecided: () => void }) {
  const admin = useTown((s) => !!s.me?.isAdmin);
  useTown((s) => s.me?.directDefaultGoalId);
  const goal = admin ? letInGoal() : null;
  const who = req.githubLogin ? `@${req.githubLogin}` : req.name;
  const decide = (grant: boolean, g?: typeof goal) => async () => { await decideJoin(req, grant, g); onDecided(); };
  return (
    <div className="doc-row intray-row">
      <div className="intray-who">
        {req.avatarUrl ? <img className="intray-avatar" src={req.avatarUrl} alt="" /> : null}
        <b>{who}</b> asks to join<span>{timeAgo(req.createdAt)}</span>
      </div>
      {req.message ? <div className="doc-row-meta"><span>"{req.message}"</span></div> : null}
      {admin ? (
        <div className="actions">
          <Act small tone="primary" run={decide(true)} title="They can move, message agents and write. No 1:1s yet.">Let in</Act>
          {goal ? <Act small run={decide(true, goal)} title={`Also lets them open 1:1s with managers under "${goal.text}" and ask for work there`}>Let in + direct work under {goal.short}</Act> : null}
          <Act small run={decide(false)}>Decline</Act>
        </div>
      ) : <div className="doc-row-meta"><span className="muted">An admin decides.</span></div>}
    </div>
  );
}

/**
 * A member asks to captain a goal (gr_bwm0iz7rwl): the goal's current captain, a captain above it or an admin accepts
 * (they become its captain: its items route to them, they can fund under it) or declines (they may ask again).
 */
export function CaptainRow({ req, route, onDecided }: { req: CaptainRequestView; route?: IntrayRoute; onDecided: () => void }) {
  const admin = useTown((s) => !!s.me?.isAdmin);
  const canDecide = route ? route.canDecide : admin;
  const who = req.githubLogin ? `@${req.githubLogin}` : req.name;
  const decide = async (action: "accept" | "decline") => {
    await api().decideCaptain(req.id, action);
    store.toast(action === "accept" ? `${who} now captains "${req.goalText}".` : `Declined ${who}'s ask to captain "${req.goalText}". They can ask again.`, "ok");
    onDecided();
  };
  return (
    <div className="doc-row intray-row">
      <RoutedTo route={route} />
      <div className="intray-who">
        {req.avatarUrl ? <img className="intray-avatar" src={req.avatarUrl} alt="" /> : null}
        <b>{who}</b> asks to captain <button className="link" onClick={() => store.open({ kind: "goals", id: req.goalId })}>{req.goalText}</button><span>{timeAgo(req.createdAt)}</span>
      </div>
      {req.note ? <div className="doc-row-meta"><span>"{req.note}"</span></div> : null}
      {canDecide ? (
        <div className="actions">
          <Act small tone="primary" run={() => decide("accept")}>Accept</Act>
          <Act small run={() => decide("decline")}>Decline</Act>
        </div>
      ) : <div className="doc-row-meta"><span className="muted">Captained today by {req.captainName}: they or an admin decide.</span></div>}
    </div>
  );
}

/**
 * A building asks for a retainer for a scheduled job (1:1 mt_cyd2t5ioob decision 2): "Workshop asks for a retainer:
 * <title>, N tokens × M runs to <date> = T". Approve (claimed in the Bank), Counter (note, per-run amount and/or end
 * date; the manager's `schedule` edit asks again) or Reject. Countered ones wait on the manager and show no buttons.
 */
export function RetainerRow({ x, route, onDecided, deckSlide, onOpenDoc }: { x: ScheduleView; route?: IntrayRoute; onDecided: () => void; deckSlide?: number; onOpenDoc?: (id: string) => void }) {
  useTown((s) => s.me);
  const canDecide = (route ? route.canDecide : store.can("building.fund", x.buildingId)) && x.retainer === "asked";
  const [note, setNote] = useState("");
  const [perRun, setPerRun] = useState("");
  const [until, setUntil] = useState("");
  const n = (t: number) => t.toLocaleString("en-US");
  const decide = (action: "approve" | "counter" | "reject") => async () => {
    const tokensPerRun = perRun ? Math.round(Number(perRun.replace(/[,_\s]/g, ""))) : undefined;
    await api().decideRetainer(x.id, { action, note, ...(action === "counter" && tokensPerRun ? { tokensPerRun } : {}), ...(action === "counter" && until ? { until: new Date(`${until}T23:59:59Z`).toISOString() } : {}), ...(deckSlide ? { deckSlide } : {}) });
    store.toast(action === "approve" ? `Retainer approved: ${n(x.askTokens)} tokens claimed in the Bank for "${x.title}".` : action === "counter" ? "Countered: the manager edits the schedule, which asks again." : "Retainer rejected: its runs stay held.", "ok");
    onDecided();
  };
  return (
    <div className="doc-row intray-row retainer-row">
      <div className="intray-who">
        <BuildingTag buildingId={x.buildingId} />
        <b>{x.buildingName ?? x.buildingId}</b> asks for a retainer<span>{timeAgo(x.updatedAt)}</span>
        <Pill tone={x.retainer === "asked" ? "warn" : ""}>{x.retainer === "asked" ? "retainer ask" : x.retainer}</Pill>
      </div>
      <div className="doc-row-title">{x.title}</div>
      <RoutedTo route={route} />
      {deckSlide ? null : <RollupAsks asks={x.asks} verb={askVerb(x.retainer)} onOpenDoc={onOpenDoc} />}
      <div className="doc-row-meta">
        <span title="Bank tokens (Opus 5.5 output tokens)"><b>{n(x.tokensPerRun)}</b> tokens × {x.runsLeft} run{x.runsLeft === 1 ? "" : "s"}{x.endsAt ? ` to ${x.endsAt.slice(0, 10)}` : ""} = <b>{n(x.askTokens)}</b></span>
        {x.drawnTokens ? <span>drawn so far {n(x.drawnTokens)}</span> : null}
      </div>
      {x.retainer === "countered" && x.retainerNote ? <div className="doc-row-meta"><span>{x.retainerNote} Waiting on the manager's edit.</span></div> : null}
      {canDecide ? (
        <>
          <div className="retainer-counter">
            <input placeholder="Note (why, or what to change)" value={note} onChange={(e) => setNote(e.target.value)} />
            <input placeholder="Per run (counter)" inputMode="numeric" value={perRun} onChange={(e) => setPerRun(e.target.value)} />
            <input type="date" title="End date (counter)" value={until} onChange={(e) => setUntil(e.target.value)} />
          </div>
          <div className="actions">
            <Act small tone="primary" run={decide("approve")}>Approve</Act>
            <Act small run={decide("counter")}>Counter</Act>
            <Act small tone="bad" run={decide("reject")}>Reject</Act>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** A building's name with the building glyph, for rows in the Town Hall in-tray. */
function BuildingTag({ buildingId }: { buildingId: string | null }) {
  const b = useTown((s) => s.buildings.find((x) => x.id === buildingId));
  return <span className="intray-building"><Glyph kind="building" />{b?.name ?? buildingId ?? "Town"}</span>;
}

/** The grant's id as a link into the grant panel (`/#/grant/<id>`, so it can be copied and pasted anywhere). */
function GrantLink({ id, className }: { id: string; className?: string }) {
  return <a className={`doc-id grant-id ${className ?? ""}`} href={grantUrl(id)} title="Open this grant" onClick={(e) => { e.preventDefault(); store.open({ kind: "grant", id }); }}>{id}</a>;
}

/** "Funded 2M tokens", "Closed: met", … for a grant nobody has to decide on right now. */
function grantSettledLine(g: GrantView): string {
  switch (g.status) {
    case "funded": return `Funded ${fmtTokens(g.grantTokens ?? 0)} ${ADJ}${g.fundedAt ? ` ${timeAgo(g.fundedAt)}` : ""}${funderLine(g)}; sessions draw on it until the next checkpoint.`;
    case "stopping": return "Stopping: its forks are wrapping up and filing their reports; it closes as stopped when no session runs on it.";
    case "closed": return `Closed${g.outcome ? `: ${g.outcome}` : ""}${g.closedAt ? `, ${timeAgo(g.closedAt)}` : ""}.`;
    case "rejected": return "Rejected.";
    case "draft": return "Draft: the manager is still writing it.";
    default: return g.status;
  }
}

/** A stopped grant's money: "spent 120k of 500k adj. tokens; 380k unspent returned to the Bank as free tokens" (or kept on the funder's input; while stopping, so far). */
function stopMoneyLine(g: GrantView, s: GrantStop): string {
  const spent = `spent ${fmtTokens(s.spentTokens)} of ${fmtTokens(s.grantTokens)} ${ADJ}`;
  if (!s.closed) return `${spent} so far; stopping`;
  return `${spent}; ${fmtTokens(s.unspentTokens)} unspent ${s.returnedTo === "pool" ? "returned to the Bank as free tokens" : `stays on ${g.fundedWithLabel ?? g.fundedWith ?? "the funder's input"}`}`;
}

/** " by Ada from Ada's key": who funded a member-funded grant and with which Bank input (grants paid by the Bank: ""). */
function funderLine(g: GrantView): string {
  return g.fundedWith ? ` by ${g.fundedByName ?? nameOf(g.fundedBy ?? "")} from ${g.fundedWithLabel ?? g.fundedWith}` : "";
}

/** The signed-in human's own Bank inputs that can still pay for a grant (member funding): active, with balance. */
function useMyFundingInputs(enabled: boolean) {
  const me = useTown((s) => s.me);
  const userId = enabled ? me?.user.id ?? null : null;
  const bank = useLoad(async () => userId ? (await api().bank()).inputs : [], [userId]);
  return (bank.data ?? []).filter((i) => i.userId === userId && !i.cancelledAt && (i.balanceTokens ?? 0) > 0);
}

/**
 * A grant's "Talk to <manager>" (Mitchell, 1:1 mt_u6euky43hg): opens my 1:1 with its proposer (else the building's
 * manager), the grant and its key result presented as the first line. Same visibility as a doc's Talk to <author>.
 */
function TalkAboutGrant({ grant: g }: { grant: GrantView }) {
  const agents = useTown((s) => s.agents);
  const buildings = useTown((s) => s.buildings);
  const me = useTown((s) => s.me);
  const t = grantTalkTarget(g.proposedBy, g.buildingId, agents, buildings);
  if (!me || !t || !canOneOnOne(g.buildingId)) return null;
  return <span className="talk-author"><Act tone="primary" run={() => openOneOnOne(g.buildingId, { grantId: g.id })} title={`Open a 1:1 with ${t.name} about this grant and its key result`}>Talk to {t.name}</Act></span>;
}

/**
 * A proposal or checkpoint row with its decision controls (POST /api/grants/:id/decide, `building.fund`); the same row
 * shows any other status read-only in the grant panel.
 */
/**
 * A grant's estimate beside its ask (Mitchell, 1:1 mt_c9u1kr15jp; advisory: the ask stands): while open, the cheap
 * model's range and the similar closed grants' ("estimate 150k–400k (model) · similar grants spent 180k–610k"), or the
 * history sentence alone before the model answered; once closed, the estimate against what it spent.
 */
function EstimateLine({ g }: { g: GrantView }) {
  const e = g.estimate;
  if (!e) return null;
  const range = (lo: number, hi: number) => lo === hi ? fmtTokens(lo) : `${fmtTokens(lo)}–${fmtTokens(hi)}`;
  const similar = e.low !== null && e.high !== null ? `similar grants spent ${range(e.low, e.high)}` : null;
  if (g.status === "closed") {
    const r = estimateRangeOf(e);
    if (!r) return null;
    const inside = g.spentTokens >= r.low && g.spentTokens <= r.high;
    return <span className="grant-estimate" title={e.sentence}>estimated {range(r.low, r.high)}{r.by === "model" ? " (model)" : " (similar grants)"}, spent {fmtTokens(g.spentTokens)}: {inside ? "inside" : "outside"} the range</span>;
  }
  if (e.model) {
    return <span className="grant-estimate" title={`${e.model.note} (${e.model.modelId}). ${e.sentence}. Advisory: the ask stands.`}>estimate {range(e.model.low, e.model.high)} (model){similar ? ` · ${similar}` : ""}</span>;
  }
  return <span className="grant-estimate" title="What it is likely to cost, read from the grants already closed (advisory: the ask stands)">likely cost: {e.sentence}</span>;
}

/**
 * `onMarked` runs after one key result is flipped to missed or back to met (default `onDecided`): it reloads and keeps
 * this grant open. A grant closed as done marks its key results met itself (town hall mt_v09cn7a8yr decision 2).
 * It leads with the summary (status, spent / granted, one line per key result); each key result's how-to-check and note
 * sit one click away (gr_zak30564zh). `onPage`: the grant's own page, whose header carries the objective and whose Plan
 * and History sections carry the stop condition and the latest note, so the row leaves those out.
 */
/** Characters of a key result shown on the grant page before its fold (about one line of the side panel). */
const KR_LINE = 50;

export function GrantRow({ grant: g, onDecided, onMarked, onOpenDoc, deckSlide, meetingId, canDecide, route, onPage }: { grant: GrantView; onDecided: () => void; onMarked?: () => void; onOpenDoc: (id: string) => void; deckSlide?: number; meetingId?: string; canDecide?: boolean; route?: IntrayRoute; onPage?: boolean }) {
  useTown((s) => s.me);
  const manager = useTown((s) => { const b = s.buildings.find((x) => x.id === g.buildingId); return b?.managerAgentId ? s.agents[b.managerAgentId] : undefined; });
  const author = useTown((s) => s.agents[g.proposedBy]);
  const signedInHuman = useTown((s) => !!s.me);
  const checkpoint = g.status === "checkpoint";
  // closed as done (close_grant or the Close grant button): its key results went to met; a human may flip one to missed
  const closedDone = g.status === "closed" && g.outcome === "done";
  const krs = g.keyResults.length ? g.keyResults : g.keyResult ? [g.keyResult] : [];
  const unspent = Math.max(0, (g.grantTokens ?? 0) - g.spentTokens);
  const ceiling = checkpoint ? g.grantTokens ?? g.askTokens : g.askTokens;
  const [tokens, setTokens] = useState(toMillions(ceiling));
  const [note, setNote] = useState("");
  // building.fund, or (step 4) the owner of the key result's goal, as the in-tray's route says (Grants.canFund)
  const canFund = store.can("building.fund", g.buildingId) || !!canDecide;
  const decidable = g.status === "proposed" || checkpoint;
  // member funding: any human may fund a proposal from their own Bank input with balance; "" = the Bank (building.fund)
  const myInputs = useMyFundingInputs(g.status === "proposed");
  const [fundWith, setFundWith] = useState("");
  const from = canFund ? fundWith : fundWith || myInputs[0]?.id || "";
  const memberFund = !canFund && g.status === "proposed" && myInputs.length > 0;
  const last = g.history[g.history.length - 1];
  const n = fromMillions(tokens);
  const tokensOk = Number.isFinite(n) && n > 0;
  const decide = (action: "fund" | "counter" | "reject" | "continue" | "adjust" | "cut", msg: string) => async () => {
    const withTokens = action === "fund" || action === "adjust" || (action === "counter" && n !== g.askTokens);
    await api().decideGrant(g.id, { action, note, ...(withTokens && tokensOk ? { tokens: n } : {}), ...(action === "fund" && from ? { fundWith: from } : {}), ...(deckSlide ? { deckSlide } : {}), ...(deckSlide && meetingId ? { meetingId } : {}) });
    store.toast(msg, "ok");
    onDecided();
  };
  const mark = (id: string, status: "met" | "missed") => async () => {
    await api().updateKeyResult(id, { status, note });
    store.toast(`Key result marked ${status}`, "ok");
    (onMarked ?? onDecided)();
  };
  const close = async () => {
    await api().closeGrant(g.id, { outcome: "done", note });
    store.toast("Grant closed: the unspent tokens are back in the Bank", "ok");
    onDecided();
  };
  // Stop grant (gr_8i952perny): a human with building.fund or the goal's captain, a reason required
  const [stopping, setStopping] = useState(false);
  const [reason, setReason] = useState("");
  const stopGrant = async () => {
    await api().stopGrant(g.id, { reason });
    store.toast("Grant stopped: its forks wrap up, its queued work is cancelled and its key results are missed", "ok");
    setStopping(false);
    onDecided();
  };
  const stop = grantStopOf(g);
  const stopForm = (g.status === "funded" || g.status === "checkpoint") && canFund && signedInHuman ? (stopping ? (
    <div className="grant-decide grant-stop">
      <div className="grant-inputs"><Field label="Why stop it"><input value={reason} autoFocus placeholder="required: the manager and the in-tray see it" onChange={(e) => setReason(e.target.value)} /></Field></div>
      <div className="muted">Its forks are asked to wrap up, its queued work is cancelled, its open key results are marked missed, and the unspent tokens go back to {g.fundedWith ? "the funder's input" : "the Bank"}.</div>
      <div className="actions">
        <Act small tone="bad" disabled={!reason.trim()} run={stopGrant}>Stop grant</Act>
        <button className="btn sm" onClick={() => setStopping(false)}>Cancel</button>
      </div>
    </div>
  ) : <div className="actions"><button className="link grant-stop-open" onClick={() => setStopping(true)} title="Stop this grant mid-work, with a reason">Stop grant…</button></div>) : null;
  // Talk to and the decision buttons sit together under the grant, big (Mitchell's flag dc_4uiv48047s)
  const talk = <TalkAboutGrant grant={g} />;
  const footer = <div className="actions decide-footer">{talk}</div>;
  const pct = g.grantTokens ? Math.round((g.spentTokens / g.grantTokens) * 100) : 0;
  // the key results and stop condition: under the fold on a checkpoint, where the evidence comes first (mt_7b4zc7yja3)
  const folded = checkpoint && !!g.evidence;
  // on the grant's own page each key result opens on one line; the full text sits in its "How to check" fold (kr_p6l1w6tade)
  const krLine = (text: string) => (onPage ? clipText(text, KR_LINE).head : text);
  const planList = (<>
      <ul className="grant-krs">
        {krs.length ? krs.map((k, i) => (
          <li key={k.id}>
            <b>Key result{krs.length > 1 ? ` ${i + 1}` : ""}:</b> {krLine(k.text)} <span className="muted">· {k.status.replace(/-/g, " ")}{k.due ? ` · due ${k.due}` : ""}</span>
            <details className="kr-more"><summary>{onPage ? "details" : `How to check${k.statusNote ? " · note" : ""}`}</summary>
              {krLine(k.text) !== k.text ? <div className="kr-full">{k.text}</div> : null}
              <div className="muted kr-check">How to check: {k.howToCheck}</div>
              {k.statusNote ? <div className="muted kr-check">{k.status.replace(/-/g, " ")}: <DocText text={k.statusNote} /></div> : null}
            </details>
            {closedDone && canFund && signedInHuman && (k.status === "met" || k.status === "missed") ? (
              <div className="actions">
                {k.status === "met"
                  ? <Act small tone="bad" disabled={!note.trim()} run={mark(k.id, "missed")} title={note.trim() ? "It did not ship: mark it missed (queues a postmortem)" : "Say why in the note first"}>Mark missed</Act>
                  : <Act small run={mark(k.id, "met")} title="Undo: back to met">Back to met</Act>}
              </div>
            ) : null}
          </li>
        )) : <li className="muted">No key results yet</li>}
        {g.testingPlan.map((t, i) => <li key={i} className="muted">Test: {t.text}</li>)}
      </ul>
      {onPage ? null : <div className="intray-proposal">Stop when: {g.stopCondition}</div>}
  </>);
  const decision = (closedDone && canFund && signedInHuman && krs.some((k) => k.status === "met") ? (<>
        <div className="muted">Closed as done: its key results are met. If one did not ship, say why and mark it missed.</div>
        <div className="grant-decide">
          <div className="grant-inputs"><Field label="Why missed"><input value={note} placeholder="required to mark one missed" onChange={(e) => setNote(e.target.value)} /></Field></div>
          <div className="actions decide-footer">{talk}</div>
        </div>
      </>) : g.status === "funded" && canFund ? (<>
        <div className="muted">{grantSettledLine(g)}</div>
        <div className="grant-decide">
          <div className="grant-inputs"><Field label="Note"><input value={note} placeholder="optional: the evidence the work is done" onChange={(e) => setNote(e.target.value)} /></Field></div>
          <div className="actions decide-footer"><Act small run={close} title="Close it as done now; the unspent tokens return to the Bank">Close grant</Act>{talk}</div>
        </div>
      </>) : g.status === "countered" ? (
        <><div className="muted">Countered: waiting for {manager ? `★ ${manager.name}` : "the manager"} to revise and propose again.</div>{footer}</>
      ) : !decidable ? (
        <><div className="muted">{grantSettledLine(g)}</div>{footer}</>
      ) : !canFund && !memberFund ? (
        <><div className="muted">Funding decisions are for humans with building.fund, the captain of its goal, or anyone with a Bank input that has tokens left.</div>{footer}</>
      ) : (<>
        {unfundableReason(g) ? <div className="kr-blocked">{unfundableReason(g)}</div> : null}
        <div className="grant-decide">
          <div className="grant-inputs">
            <Field label={checkpoint ? "Grant" : "Fund"}><MTokensInput value={tokens} onChange={setTokens} /></Field>
            {!checkpoint && myInputs.length > 0 ? (
              <Field label="Pay from">
                <select value={from} onChange={(e) => setFundWith(e.target.value)} aria-label="Pay from">
                  {canFund ? <option value="">The Bank</option> : null}
                  {myInputs.map((i) => <option key={i.id} value={i.id}>{i.label}: {fmtTokens(i.balanceTokens ?? 0)} left</option>)}
                </select>
              </Field>
            ) : null}
            <Field label="Note"><input value={note} placeholder={checkpoint ? "optional" : memberFund ? "optional" : "required to counter"} onChange={(e) => setNote(e.target.value)} /></Field>
          </div>
          <div className="actions decide-footer">
            {checkpoint ? <>
              <Act small tone="ok" run={decide("continue", "Grant continued")}>Continue</Act>
              <Act small disabled={!tokensOk} run={decide("adjust", "Grant adjusted")} title="Set the grant to the token field">Adjust</Act>
              <Act small tone="bad" run={decide("cut", "Grant cut")}>Cut</Act>
            </> : <>
              <Act small tone="ok" disabled={!tokensOk || !!unfundableReason(g)} run={decide("fund", `Funded ${tokensOk ? fmtTokens(n) : ""} ${ADJ}`)}>Fund</Act>
              {canFund ? <>
                <Act small disabled={!note.trim()} run={decide("counter", "Countered: back to the manager")} title="Send it back with the note (and the token field, if changed)">Counter</Act>
                <Act small tone="bad" run={decide("reject", "Proposal rejected")}>Reject</Act>
              </> : null}
            </>}
            {talk}
          </div>
        </div>
      </>));
  return (
    <div className="doc-row intray-row grant-row">
      <div className="intray-who">
        <BuildingTag buildingId={g.buildingId} />
        {author ? <img src={portraitUrl(author.sprite, 1)} alt="" /> : null}<b>{manager ? `★ ${manager.name}` : nameOf(g.proposedBy)}</b>
        <span>{timeAgo(g.updatedAt)}</span>
        <Pill tone={checkpoint ? "warn" : g.status === "rejected" || stop ? "bad" : g.status === "countered" || g.status === "draft" || g.status === "closed" ? "" : "ok"}>{stop && g.status === "closed" ? "stopped" : g.status}</Pill>
        {/* on its own page the header already names this grant: no link to itself */}
        {onPage ? null : <GrantLink id={g.id} />}
      </div>
      {onPage ? null : <div className="doc-row-title">{g.objective}</div>}
      <RoutedTo route={route} />
      {/* on a deck slide the slide text carries the ask */}
      {deckSlide ? null : <RollupAsks asks={g.asks} verb={askVerb(g.status)} onOpenDoc={onOpenDoc} />}
      <div className="doc-row-meta">
        {stop
          ? <span title={breakdownTitle(g.spentCounts)}>{stopMoneyLine(g, stop)}</span>
          : closedDone
          ? <span title={breakdownTitle(g.spentCounts)}>spent {fmtTokens(g.spentTokens)} of {fmtTokens(g.grantTokens ?? 0)} {ADJ}; returned {fmtTokens(unspent)} unspent to the Bank</span>
          : checkpoint
          ? <span title={breakdownTitle(g.spentCounts)}>{fmtTokens(g.spentTokens)} of {fmtTokens(g.grantTokens ?? 0)} {ADJ} spent ({pct}%)</span>
          : <span title={ADJ_HINT}>asks {fmtTokens(g.askTokens)} {ADJ}</span>}
        <EstimateLine g={g} />
        {g.checkpointDocId ? <button className="link" onClick={() => onOpenDoc(g.checkpointDocId!)}>{closedDone ? "close report" : "checkpoint report"}</button> : null}
      </div>
      {g.evidence ? <CheckpointEvidenceBlock e={g.evidence} onOpenDoc={onOpenDoc} earlier={!checkpoint} /> : null}
      {folded ? null : planList}
      {stop
        ? <div className="intray-proposal grant-stopped-by"><b>{nameOf(stop.byId)} stopped it</b> {timeAgo(stop.at)}: <DocText text={stop.reason} /></div>
        : last?.note && !onPage ? <div className="intray-proposal">{historyActor(last, nameOf)} ({last.action}): <DocText text={historyNote(last)} /></div> : null}
      {decision}
      {stopForm}
      {folded ? <details className="grant-plan"><summary>The plan as funded: key results and stop condition</summary>{planList}</details> : null}
    </div>
  );
}

/**
 * What a checkpoint shipped (Mitchell 1:1 mt_7b4zc7yja3): one line per key result "✓ shipped / ✗ not shipped / ~ partly:
 * <the manager's note>", spent vs granted, what a top-up buys, and the checkpoint report's Shipped titles. On a proposal
 * (`earlier`) it is the earlier grant the proposal names in `continues` (1:1 mt_z1b38bwg98); none named, no block.
 */
function CheckpointEvidenceBlock({ e, onOpenDoc, earlier }: { e: CheckpointEvidence; onOpenDoc: (id: string) => void; earlier?: boolean }) {
  return (
    <div className="checkpoint-evidence">
      {earlier ? <div className="muted">Continues the earlier grant <GrantLink id={e.grantId} /> {e.objective}</div> : null}
      <ol className="evidence-krs">
        {e.keyResults.map((k) => <li key={k.id} className={`evidence-${k.verdict}`} title={k.text}>{evidenceKrLine(k)}</li>)}
      </ol>
      {earlier ? <div>Spent {fmtTokens(e.spentTokens)} of {fmtTokens(e.grantTokens)} {ADJ} granted.</div> : null}
      <div className={e.topUpTokens && e.whatTopUpBuys ? "" : "muted"}>{topUpLine(e)}</div>
      {e.shipped.length ? <div>Shipped in the {e.reportId ? <button className="link" onClick={() => onOpenDoc(e.reportId!)}>checkpoint report</button> : "checkpoint report"}: {e.shipped.join(" · ")}</div> : null}
    </div>
  );
}

/** Report id → the in-tray rows (grant or retainer ids) that show its ask (`asks`): the report's card says its ask moved there. */
export function askedOnOf(grants: GrantView[], retainers: ScheduleView[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const x of [...grants, ...retainers]) for (const a of x.asks ?? []) m.set(a.reportId, [...(m.get(a.reportId) ?? []), x.id]);
  return m;
}

function IntrayRow({ doc, chain, onOpen, onOpenDoc, showBuilding, askedOn }: { doc: Doc; chain?: ReportChain; onOpen: () => void; onOpenDoc?: (id: string) => void; showBuilding?: boolean; askedOn?: string[] }) {
  // a retired fork isn't in the snapshot: its row shows its manager's sprite
  const a = useTown((s) => s.agents[doc.authorId] ?? (chain?.forkOf ? s.agents[chain.forkOf] : undefined));
  const isManager = useTown((s) => !!doc.buildingId && s.buildings.some((b) => b.id === doc.buildingId && b.kind !== "town-hall" && b.managerAgentId === doc.authorId));
  const flag = doc.type === "flag";
  const need = flag ? null : needOf(doc.body);
  const preview = flag && doc.body.trim() !== doc.title ? doc.body.replace(/\s+/g, " ") : null;
  const rollup = doc.tags.includes("rollup");
  const covered = doc.provenance.sourceIds;
  const cards = rollup ? rollupCardsOf(doc) : null;
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
        <MediaThumb body={doc.body} />
        <div className="intray-who">
          {showBuilding ? <BuildingTag buildingId={doc.buildingId} /> : null}
          {a ? <img src={portraitUrl(a.sprite, 1)} alt="" /> : null}<b title={chain?.forkOf ? forkTip(chain, nameOf, chain.assignmentId, chain.sessionId) : undefined}>{isManager ? `★ ${nameOf(doc.authorId)}` : nameOf(doc.authorId)}</b><span>{timeAgo(doc.createdAt)}</span>
          {rollup ? <Pill tone="ok">rollup</Pill> : null}
          {doc.tags.includes("visitor") ? <Pill tone="warn" title="A visitor agent with no home building filed this; a human works it">visitor report</Pill> : null}
          {flag ? <Pill tone="warn" title="A quick request a human planted here; the manager delegates it">⚑ flag</Pill> : null}
        </div>
        <div className="doc-row-title">{doc.title}</div>
        {need ? <div className="intray-proposal">Needs: {need}</div> : null}
        {askedOn?.length ? <div className="intray-proposal muted">Its ask on {askedOn.join(", ")} is on {askedOn.length === 1 ? "that row" : "those rows"} below.</div> : null}
        {preview ? <div className="intray-proposal">{preview}</div> : null}
        <div className="doc-row-meta">
          {doc.verdict ? <Pill tone={VERDICT_TONE[doc.verdict]}>verdict: {doc.verdict}</Pill> : null}
          {doc.tokens ? <span title={ADJ_HINT}>{fmtTokens(doc.tokens)} {ADJ}{doc.costUsd ? ` · ${usd(doc.costUsd)}` : ""}</span> : null}
        </div>
      </button>
      {cards ? <div className="intray-cards"><RollupCards parsed={cards} /></div> : null}
      {chain ? (
        // a fork's report: its place on the assignment chain, the fork's session (agent panel) and the previous hop
        <div className="intray-covered intray-chain">
          <button className="link" title={`The fork's session${chain.sessionId ? ` ${chain.sessionId}` : ""}: tokens and transcript`} onClick={() => store.open({ kind: "agent", id: doc.authorId })}>
            <Pill tone="neutral">chain {chain.chainId} · hop {chain.hop}</Pill>
          </button>
          {chain.prevReportId ? <button className="link" onClick={() => onOpenDoc?.(chain.prevReportId!)}>← previous hop</button> : <span className="muted">first hop</span>}
        </div>
      ) : null}
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
  const rev = useTown((s) => s.rev);
  const board = useLoad(() => api().board(buildingId, 50), [buildingId, rev]);
  if (b?.kind === "town-hall") return (
    <PanelShell icon={<Glyph kind="board" />} title="Town Hall board" subtitle="Town-wide FYIs: each one shows in the Town-wide section of every building's board and in every agent's brief.">
      {canPostTownBoard() ? <TownNoteForm buildingId={b.id} onPosted={board.reload} /> : null}
      <DocList board={board} onUnpublished={board.reload} onEdited={board.reload} />
    </PanelShell>
  );
  return (
    <PanelShell icon={<Glyph kind="board" />} title={`${b?.name ?? "Building"} board`} subtitle="Notes only: town-wide FYIs, the manager's standing rules and building-wide FYIs. The goal's key results and grants are on the building's Goals and Grants tabs; everything else is in the filing cabinet beside it.">
      <DocList board={board} townWide onEdited={board.reload} />
      {b ? <StandingRules buildingId={b.id} rules={b.rules ?? ""} /> : null}
      <DocList board={board} onEdited={board.reload} />
    </PanelShell>
  );
}

/** = core canPostTownBoard for a signed-in human: a town admin, or building.manage on any building. */
export function canPostTownBoard(): boolean {
  return store.can("building.manage") || (store.state.me?.roles ?? []).some((r) => r.permissions.includes("building.manage"));
}

/** = core unpublishTownFyi's rule: the FYI's author or a town admin. */
export function canUnpublish(d: Doc): boolean {
  const me = store.state.me;
  return !!me && (me.isAdmin || d.authorId === me.user.id);
}

/** = core canEditBoardNote's rule (flag dc_4itg2gxfqf): the note's author, a town admin, or a manager of its building. Guests: never. */
export function canEditBoardNote(d: Doc): boolean {
  const me = store.state.me;
  return !!me && (me.isAdmin || d.authorId === me.user.id || store.can("building.manage", d.buildingId));
}

/** The Town Hall board's "Post a town-wide note" (Mitchell's flag dc_ym8fjxqjiv): a type fyi doc, state building, buildingId town-hall. */
export function TownNoteForm({ buildingId, onPosted }: { buildingId: string; onPosted: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const media = useMediaPaste(setBody);
  return (
    <div className="rules-card town-note-form">
      <div className="rules-head"><b>Post a town-wide note</b><span>every building's board shows it at once, and every agent reads it when a session starts</span></div>
      <form className="form" onSubmit={(e) => e.preventDefault()}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" />
        <textarea {...media.props} rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What everyone in every building needs to know. Markdown; paste or drop a screenshot." aria-label="Body" />
        <div className="actions">
          <Act tone="primary" disabled={!title.trim() || !body.trim()} run={async () => {
            const d = await api().writeDoc({ type: "fyi", state: "building", buildingId, title: title.trim(), body: body.trim() });
            store.putDocs([d]);
            setTitle(""); setBody("");
            store.toast("Posted to the Town Hall board: it shows on every building's board", "ok");
            onPosted();
          }}>Post to every building</Act>
        </div>
      </form>
    </div>
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

/**
 * Board FYIs, newest first. `townWide`: the "Town-wide" section (the Town Hall board's FYIs, which the API lists first
 * on every building's board), hidden when there are none; otherwise the building's own FYIs.
 */
function DocList({ board: list, townWide = false, onUnpublished, onEdited }: { board: { data: Board | null; error: string | null; loading: boolean }; townWide?: boolean; /** the Town Hall board: rows get "Take off the board" for their author or an admin */ onUnpublished?: () => void; /** rows get "Edit" for their author, an admin or the building's manager */ onEdited?: () => void }) {
  const [open, setOpen] = useState<Doc | null>(null);
  const all = list.data?.docs;
  const docs = useMemo(() => all?.filter((d) => !!d.townWide === townWide), [all, townWide]);
  useEffect(() => { if (docs) store.putDocs(docs); }, [docs]);
  if (open) return <DocView doc={open} onBack={() => setOpen(null)} backLabel="Board" />;
  const row = (d: Doc) => <BoardNoteRow key={d.id} doc={d} onOpen={() => setOpen(d)} onUnpublished={onUnpublished} onEdited={onEdited} />;
  if (townWide) return docs?.length ? (
    <>
      <h4 className="sub-head">Town-wide <span className="muted">from the Town Hall board; they apply in every building</span></h4>
      <div className="doc-list">{docs.map(row)}</div>
    </>
  ) : null;
  return (
    <>
      <ErrorLine error={list.error} />
      {list.loading && !list.data ? <Loading /> : !docs?.length ? <Empty>No FYIs on the board.</Empty> : (
        <div className="doc-list">{docs.map(row)}</div>
      )}
    </>
  );
}

/** One board note: its row, plus "Edit" (title and body inline, flag dc_4itg2gxfqf) and, on the Town Hall board, "Take off the board". */
export function BoardNoteRow({ doc: d, onOpen, onUnpublished, onEdited }: { doc: Doc; onOpen: () => void; onUnpublished?: () => void; onEdited?: () => void }) {
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null);
  const media = useMediaPaste((body) => setDraft((x) => x && { ...x, body: typeof body === "function" ? body(x.body) : body }));
  const edit = !!onEdited && canEditBoardNote(d);
  const unpublish = !!onUnpublished && canUnpublish(d);
  if (draft) return (
    <div className="rules-card board-note-edit">
      <form className="form" onSubmit={(e) => e.preventDefault()}>
        <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Title" aria-label="Title" autoFocus />
        <textarea {...media.props} rows={6} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} placeholder="Markdown; paste or drop a screenshot." aria-label="Body" />
        <div className="actions">
          <Act tone="primary" disabled={!draft.title.trim() || !draft.body.trim()} run={async () => {
            const r = await api().editBoardNote(d.id, { title: draft.title.trim(), body: draft.body.trim() });
            store.putDocs([r]);
            setDraft(null);
            store.toast(`Saved "${r.title}" on the board`, "ok");
            onEdited?.();
          }}>Save</Act>
          <button type="button" className="btn" onClick={() => setDraft(null)}>Cancel</button>
        </div>
      </form>
    </div>
  );
  if (!edit && !unpublish) return <DocRow doc={d} onOpen={onOpen} />;
  return (
    <div className="board-fyi">
      <DocRow doc={d} onOpen={onOpen} />
      {edit ? <button type="button" className="btn sm" onClick={() => setDraft({ title: d.title, body: d.body })} title="Edit the note's title and body in place">Edit</button> : null}
      {unpublish ? <Act run={async () => {
        const r = await api().unpublish(d.id);
        store.putDocs([r]);
        store.toast(`"${d.title}" is off the Town Hall board (back in ${d.authorId === store.state.me?.user.id ? "your" : `${nameOf(d.authorId)}'s`} drafts)`, "ok");
        onUnpublished?.();
      }} small title="Back to its author's drafts: it leaves every building's Town-wide section">Take off the board</Act> : null}
    </div>
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
  const canBan = store.can("town.ban");
  const tabs = ["Requests", "Bans"];
  return (
    <PanelShell icon={<Glyph kind="mod" />} title="Mod station" subtitle={canRequests || canBan ? "Collective-wide misuse prevention" : `Read-only${me ? ` · ${me.user.name} isn't an admin` : ""}`} tabs={tabs}>
      {(t) => (
        <>
          {t === "Requests" ? <ModRequests can={canRequests} /> : null}
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
  const active = (list.data ?? []).filter((d) => d.requestStatus === "open" || d.requestStatus === "claimed").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (open) return <DocView doc={open} onBack={() => setOpen(null)} backLabel="Requests" />;
  return (
    <>
      <p className="direction">Agents' requests go straight to the outbox, where any human decides whether to do one. Delete a request only if it misuses the town.</p>
      <ErrorLine error={list.error} />
      {list.loading && !list.data ? <Loading /> : !active.length ? <Empty>No open requests.</Empty> : active.map((d) => <RequestCard key={d.id} doc={d} onOpen={() => setOpen(d)} moderate={can} />)}
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
      ) : <div className="callout">Banning is for admins.</div>}
      <Section title="Recent bans">
        {!bans.length ? <Empty>No bans in the recent log.</Empty> : bans.map((e) => (
          <div key={e.id} className="ev bad"><time title={e.ts}>{timeAgo(e.ts)}</time><span>{e.text}</span></div>
        ))}
      </Section>
    </>
  );
}
