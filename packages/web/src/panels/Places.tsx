/**
 * Panels that belong to places on the map: the in-tray (manager's desk), the building board,
 * the filing cabinet, the schedule board and the mod station (Town Hall). Donating is at the Bank (BankFunding.tsx).
 */
import { useEffect, useMemo, useState } from "react";
import { BOARD_TYPES, DocType, type AccessRequestView, type CaptainRequestView, type Doc, type FunderWeek, type GrantView, type IntrayRoute, type Meeting } from "@muster-town/schema";
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
import { canOneOnOne, grantTalkTarget, openOneOnOne } from "./oneOnOne";
import { RollupCards, rollupCardsOf } from "./RollupCards";
import { ReviewDeckView } from "./ReviewDeck";
import { fundedOnly, isFunder, type IntrayView } from "./funderFilter";
import { GoalProposalItem } from "./GoalTreePanel";

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
  const hidden = isHall ? allReports.length + (list.data?.grants?.length ?? 0) + (list.data?.goalProposals?.length ?? 0) + (list.data?.captains?.length ?? 0) - reports.length - grants.length - goalProposals.length - captains.length : 0;
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
  const count = reports.length + grants.length + goalProposals.length + access.length + captains.length - flags;
  return (
    <PanelShell icon={<Glyph kind="intray" />} title={<>In-tray {count ? <Pill tone="warn" title="Reports, rollups and proposals waiting">{count}</Pill> : null}{flags ? <> <Pill tone="warn" title="Flags humans planted here, waiting for the manager to delegate">⚑ {flags}</Pill></> : null}</>} subtitle={subtitle}>
      {open ? (
        <DocView doc={open} review onBack={() => setOpenId(null)} backLabel={asDeck ? "Review deck" : "In-tray"} onDecided={() => { setOpenId(null); list.reload(); }} />
      ) : hall && asDeck ? (
        <ReviewDeckView grants={grants} reports={reports} goalProposals={goalProposals} captains={captains} view={view} funder={funder} onClose={() => setAsDeck(false)} onDecided={list.reload} onOpenDoc={openDoc} />
      ) : (
        <>
          {!canReview && !hall ? <div className="callout">You can read the in-tray. Decisions are for the building's manager and reviewer.</div> : null}
          {manager && !hall ? <div className="callout">★ {manager.name}, the building's manager, works this in-tray and rolls up to the Town Hall in-tray. You can still decide here.</div> : null}
          {hall ? <ReviewAsDeckButton count={count} onOpen={() => setAsDeck(true)} view={signedIn ? { view, hidden, set: setView, funder: !!funder } : undefined} /> : null}
          <ErrorLine error={list.error} />
          {list.loading && !list.data ? <Loading /> : hall ? (
            <TownHallIntray reports={reports} grants={grants} goalProposals={goalProposals} routes={routes} access={access} captains={captains} blocked={list.data?.blocked ?? []} onOpen={openDoc} onDecided={list.reload} />
          ) : !reports.length ? <Empty>The in-tray is empty. When the manager or a fork finishes a session, its report lands here and that agent goes idle; a flag you plant (F on the map) lands here too.</Empty> : (
            <div className="doc-list">
              {reports.map((d) => <IntrayRow key={d.id} doc={d} chain={list.data?.chains?.[d.id]} onOpen={() => setOpenId(d.id)} onOpenDoc={openDoc} />)}
            </div>
          )}
        </>
      )}
    </PanelShell>
  );
}

/** The Town Hall in-tray header's "Review as deck": the in-tray as slides (design dc_y7a8g257of §2). */
export function ReviewAsDeckButton({ count, onOpen, view }: { count: number; onOpen: () => void; view?: { view: IntrayView; hidden: number; set: (v: IntrayView) => void; funder?: boolean } }) {
  return (
    <div className="intray-head actions">
      <button className="btn sm primary" onClick={onOpen} title="One slide per pending decision, blocking-most first, with the decision buttons on each slide (← → to move)">▶ Review as deck</button>
      <span className="muted">{view?.view === "funded" ? `${count} under the goals your money reached: slide 1 is your week as a funder` : count ? `${count} waiting: slide 1 is the state of the town` : "slide 1 is the state of the town"}</span>
      {view ? (
        <span className="intray-view" role="group" aria-label="Show">
          <button className={`btn sm ${view.view === "mine" ? "primary" : ""}`} onClick={() => view.set("mine")} title="Items routed to you: the goals you captain (an admin's: the town admins' root)">Mine</button>
          <button className={`btn sm ${view.view === "all" ? "primary" : ""}`} onClick={() => view.set("all")} title="Everything waiting in the Town Hall">All</button>
          {view.funder ? <button className={`btn sm ${view.view === "funded" ? "primary" : ""}`} onClick={() => view.set("funded")} title="What your Bank inputs paid for this week, and the items under the goals your money reached">Funded by me</button> : null}
          {view.view !== "all" && view.hidden ? <span className="muted">{view.hidden} more under All</span> : null}
        </span>
      ) : null}
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
function TownHallIntray({ reports, grants, goalProposals, routes, access, captains, blocked, onOpen, onDecided }: { reports: Doc[]; grants: GrantView[]; goalProposals: GoalProposalView[]; routes: Record<string, IntrayRoute>; access: AccessRequestView[]; captains: CaptainRequestView[]; blocked: NonNullable<Intray["blocked"]>; onOpen: (id: string) => void; onDecided: () => void }) {
  const proposals = grants.filter((g) => g.status === "proposed" || g.status === "countered");
  const checkpoints = grants.filter((g) => g.status === "checkpoint");
  const closes = grants.filter((g) => g.status === "closed");
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
      <div className="doc-list">{access.map((r) => <AccessRow key={r.id} req={r} onDecided={onDecided} />)}</div>
    </Section>
  ) : null;
  const captainList = captains.length ? (
    <Section title={<>Asking to captain a goal <Pill>{captains.length}</Pill></>}>
      <div className="doc-list">{captains.map((r) => <CaptainRow key={r.id} req={r} route={routes[r.id]} onDecided={onDecided} />)}</div>
    </Section>
  ) : null;
  const goalList = goalProposals.length ? (
    <Section title={<>Goal proposals <Pill>{goalProposals.length}</Pill></>}>
      <div className="goal-proposals">{goalProposals.map((p) => <div key={p.id}><RoutedTo route={routes[p.id]} /><GoalProposalItem p={p} onDone={onDecided} /></div>)}</div>
    </Section>
  ) : null;
  if (!reports.length && !grants.length && !goalProposals.length) return <>{asking}{captainList}{blockedList}{asking || captainList ? null : <Empty>The Town Hall in-tray is empty. Managers' rollups, checkpoint reports, visitor reports and escalations land here, with the grant proposals and checkpoints waiting for a human, and people asking to join or to captain a goal.</Empty>}</>;
  return (
    <>
      {asking}
      {captainList}
      {blockedList}
      {reports.length ? (
        <Section title={<>Manager reports <Pill>{reports.length}</Pill></>}>
          <div className="doc-list">{reports.map((d) => <IntrayRow key={d.id} doc={d} onOpen={() => onOpen(d.id)} onOpenDoc={onOpen} showBuilding />)}</div>
        </Section>
      ) : null}
      {proposals.length ? (
        <Section title={<>Proposals <Pill>{proposals.length}</Pill></>}>
          <div className="doc-list">{proposals.map((g) => <GrantRow key={g.id} grant={g} canDecide={routes[g.id]?.canDecide} route={routes[g.id]} onDecided={onDecided} onOpenDoc={onOpen} />)}</div>
        </Section>
      ) : null}
      {checkpoints.length ? (
        <Section title={<>Checkpoints <Pill>{checkpoints.length}</Pill></>}>
          <div className="doc-list">{checkpoints.map((g) => <GrantRow key={g.id} grant={g} canDecide={routes[g.id]?.canDecide} route={routes[g.id]} onDecided={onDecided} onOpenDoc={onOpen} />)}</div>
        </Section>
      ) : null}
      {goalList}
      {closes.length ? (
        <Section title={<>Closed as done: mark the key result <Pill>{closes.length}</Pill></>}>
          <div className="doc-list">{closes.map((g) => <GrantRow key={g.id} grant={g} canDecide={routes[g.id]?.canDecide} route={routes[g.id]} onDecided={onDecided} onOpenDoc={onOpen} />)}</div>
        </Section>
      ) : null}
    </>
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
function AccessRow({ req, onDecided }: { req: AccessRequestView; onDecided: () => void }) {
  const admin = useTown((s) => !!s.me?.isAdmin);
  const who = req.githubLogin ? `@${req.githubLogin}` : req.name;
  const decide = async (grant: boolean) => {
    await api().decideAccess(req.id, grant);
    store.toast(grant ? `${who} is in: they can now talk, message agents and write.` : `Declined ${who}. They can ask again tomorrow.`, "ok");
    onDecided();
  };
  return (
    <div className="doc-row intray-row">
      <div className="intray-who">
        {req.avatarUrl ? <img className="intray-avatar" src={req.avatarUrl} alt="" /> : null}
        <b>{who}</b> asks to join<span>{timeAgo(req.createdAt)}</span>
      </div>
      {req.message ? <div className="doc-row-meta"><span>"{req.message}"</span></div> : null}
      {admin ? (
        <div className="actions">
          <Act small tone="primary" run={() => decide(true)}>Let in</Act>
          <Act small run={() => decide(false)}>Decline</Act>
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

/** A building's name with the building glyph, for rows in the Town Hall in-tray. */
function BuildingTag({ buildingId }: { buildingId: string | null }) {
  const b = useTown((s) => s.buildings.find((x) => x.id === buildingId));
  return <span className="intray-building"><Glyph kind="building" />{b?.name ?? buildingId ?? "Town"}</span>;
}

/** The grant's id as a link into the grant panel (`/#/grant/<id>`, so it can be copied and pasted anywhere). */
export function GrantLink({ id, className }: { id: string; className?: string }) {
  return <a className={`doc-id grant-id ${className ?? ""}`} href={grantUrl(id)} title="Open this grant" onClick={(e) => { e.preventDefault(); store.open({ kind: "grant", id }); }}>{id}</a>;
}

/** "Funded 2M tokens", "Closed: met", … for a grant nobody has to decide on right now. */
function grantSettledLine(g: GrantView): string {
  switch (g.status) {
    case "funded": return `Funded ${fmtTokens(g.grantTokens ?? 0)} ${ADJ}${g.fundedAt ? ` ${timeAgo(g.fundedAt)}` : ""}${funderLine(g)}; sessions draw on it until the next checkpoint.`;
    case "closed": return `Closed${g.outcome ? `: ${g.outcome}` : ""}${g.closedAt ? `, ${timeAgo(g.closedAt)}` : ""}.`;
    case "rejected": return "Rejected.";
    case "draft": return "Draft: the manager is still writing it.";
    default: return g.status;
  }
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
export function GrantRow({ grant: g, onDecided, onOpenDoc, deckSlide, meetingId, canDecide, route }: { grant: GrantView; onDecided: () => void; onOpenDoc: (id: string) => void; deckSlide?: number; meetingId?: string; canDecide?: boolean; route?: IntrayRoute }) {
  useTown((s) => s.me);
  const manager = useTown((s) => { const b = s.buildings.find((x) => x.id === g.buildingId); return b?.managerAgentId ? s.agents[b.managerAgentId] : undefined; });
  const author = useTown((s) => s.agents[g.proposedBy]);
  const checkpoint = g.status === "checkpoint";
  // the manager closed it early as done (close_grant): a human marks each of its claimed key results met or missed
  const closedDone = g.status === "closed" && g.outcome === "done";
  const krs = g.keyResults.length ? g.keyResults : g.keyResult ? [g.keyResult] : [];
  const toMark = closedDone && krs.some((k) => k.status === "claimed");
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
    onDecided();
  };
  const close = async () => {
    await api().closeGrant(g.id, { outcome: "done", note });
    store.toast("Grant closed: the unspent tokens are back in the Bank", "ok");
    onDecided();
  };
  // Talk to and the decision buttons sit together under the grant, big (Mitchell's flag dc_4uiv48047s)
  const talk = <TalkAboutGrant grant={g} />;
  const footer = <div className="actions decide-footer">{talk}</div>;
  const pct = g.grantTokens ? Math.min(100, Math.round((g.spentTokens / g.grantTokens) * 100)) : 0;
  return (
    <div className="doc-row intray-row grant-row">
      <div className="intray-who">
        <BuildingTag buildingId={g.buildingId} />
        {author ? <img src={portraitUrl(author.sprite, 1)} alt="" /> : null}<b>{manager ? `★ ${manager.name}` : nameOf(g.proposedBy)}</b>
        <span>{timeAgo(g.updatedAt)}</span>
        <Pill tone={checkpoint ? "warn" : g.status === "rejected" ? "bad" : g.status === "countered" || g.status === "draft" || g.status === "closed" ? "" : "ok"}>{g.status}</Pill>
        <GrantLink id={g.id} />
      </div>
      <div className="doc-row-title">{g.objective}</div>
      <RoutedTo route={route} />
      <div className="doc-row-meta">
        {closedDone
          ? <span title={breakdownTitle(g.spentCounts)}>spent {fmtTokens(g.spentTokens)} of {fmtTokens(g.grantTokens ?? 0)} {ADJ}; returned {fmtTokens(unspent)} unspent to the Bank</span>
          : checkpoint
          ? <span title={breakdownTitle(g.spentCounts)}>{fmtTokens(g.spentTokens)} of {fmtTokens(g.grantTokens ?? 0)} {ADJ} spent ({pct}%)</span>
          : <span title={ADJ_HINT}>asks {fmtTokens(g.askTokens)} {ADJ}</span>}
        {g.checkpointDocId ? <button className="link" onClick={() => onOpenDoc(g.checkpointDocId!)}>{closedDone ? "close report" : "checkpoint report"}</button> : null}
      </div>
      <ul className="grant-krs">
        {krs.length ? krs.map((k, i) => (
          <li key={k.id}>
            <b>Key result{krs.length > 1 ? ` ${i + 1}` : ""}:</b> {k.text} <span className="muted">· {k.status.replace(/-/g, " ")}{k.due ? ` · due ${k.due}` : ""}</span>
            <div className="muted kr-check">How to check: {k.howToCheck}</div>
            {toMark && canFund && k.status === "claimed" ? (
              <div className="actions">
                <Act small tone="ok" run={mark(k.id, "met")}>Mark {krs.length > 1 ? "met" : "key result met"}</Act>
                <Act small tone="bad" run={mark(k.id, "missed")}>Mark missed</Act>
              </div>
            ) : null}
          </li>
        )) : <li className="muted">No key results yet</li>}
        {g.testingPlan.map((t, i) => <li key={i} className="muted">Test: {t.text}</li>)}
      </ul>
      <div className="intray-proposal">Stop when: {g.stopCondition}</div>
      {last?.note ? <div className="intray-proposal">{nameOf(last.byId)} ({last.action}): <DocText text={last.note} /></div> : null}
      {toMark ? (canFund ? (
        <div className="grant-decide">
          <div className="grant-inputs"><Field label="Note"><input value={note} placeholder="optional" onChange={(e) => setNote(e.target.value)} /></Field></div>
          <div className="actions decide-footer">{talk}</div>
        </div>
      ) : <><div className="muted">Closed as done: a human with building.fund marks each key result met or missed.</div>{footer}</>) : g.status === "funded" && canFund ? (<>
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
      </>)}
    </div>
  );
}

function IntrayRow({ doc, chain, onOpen, onOpenDoc, showBuilding }: { doc: Doc; chain?: ReportChain; onOpen: () => void; onOpenDoc?: (id: string) => void; showBuilding?: boolean }) {
  // a retired fork isn't in the snapshot: its row shows its manager's sprite
  const a = useTown((s) => s.agents[doc.authorId] ?? (chain?.forkOf ? s.agents[chain.forkOf] : undefined));
  const isManager = useTown((s) => !!doc.buildingId && s.buildings.find((b) => b.id === doc.buildingId)?.managerAgentId === doc.authorId);
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
    <PanelShell icon={<Glyph kind="mod" />} title="Mod station" subtitle={canRequests || canBan ? "Collective-wide misuse prevention" : `Read-only${me ? ` · ${me.user.name} isn't a moderator` : ""}`} tabs={tabs}>
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
      ) : <div className="callout">Banning needs the town moderator role.</div>}
      <Section title="Recent bans">
        {!bans.length ? <Empty>No bans in the recent log.</Empty> : bans.map((e) => (
          <div key={e.id} className="ev bad"><time title={e.ts}>{timeAgo(e.ts)}</time><span>{e.text}</span></div>
        ))}
      </Section>
    </>
  );
}
