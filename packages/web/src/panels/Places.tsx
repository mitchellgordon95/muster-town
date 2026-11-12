/**
 * Panels that belong to places on the map: the in-tray (manager's desk), the building board,
 * the filing cabinet, the schedule board and the mod station (Town Hall). Donating is at the Bank (BankFunding.tsx).
 */
import { useEffect, useMemo, useState } from "react";
import { BOARD_TYPES, DocType, grantName, isJudgedKr, krStatusWords, askVerb, estimateRangeOf, type AccessRequestView, type RollupAsk, type CaptainRequestView, type CheckpointEvidence, type Doc, evidenceKrLine, NO_FORK_EVIDENCE, grantStepWord, grantStopOf, topUpLine, type GrantStop, type ScheduleView, type FunderWeek, type GrantView, type IntrayRoute, type Meeting, type DigestRunView, historyActor, historyNote } from "@muster-town/schema";
import { api, type Board, type BulletinNote, type ThreadEntry } from "../api";
import { unfundableReason } from "./keyResults";
import { store, useTown, roleOf } from "../state";
import { DocRow, DocSheet, DocView } from "./DocView";
import { Glyph, PanelShell } from "./PanelShell";
import { phaseTone } from "./room";
import { DocText, Markdown } from "./Markdown";
import { grantUrl } from "../route";
import { ADJ, ADJ_HINT, Act, Empty, ErrorLine, Field, Loading, MTokensInput, Pill, Section, breakdownTitle, clock, fmtTokens, nameOf, timeAgo, useLoad, useNameOf } from "./ui";
import { fromMillions, toMillions } from "../format";
import { portraitUrl } from "../map/sprites";
import { AttachButton } from "./AttachButton";
import { useMediaPaste } from "./mediaPaste";
import { clipText } from "./showMore";
import { canOneOnOne, grantTalkTarget, openOneOnOne } from "./oneOnOne";
import { decideJoin, letInGoal } from "./letIn";
import { fundedOnly, type IntrayView } from "./funderFilter";
import { CompactLine, reportPill } from "./intrayList";
import { StepStrip } from "./StepStrip";

/** The decision queue's "Mine / All" (docs/goals.md step 4): under Mine, only the items routed to the viewer. */
export function mineOnly<T extends { id: string }>(items: T[], routes: Record<string, IntrayRoute>, view: IntrayView, funder?: FunderWeek | null): T[] {
  if (view === "funded") return funder ? fundedOnly(items, routes, funder) : items;
  return view === "all" ? items : items.filter((x) => routes[x.id]?.mine);
}

// ---------- in-tray ----------

/**
 * A building's in-tray (the manager's desk): its pending reports and flags, one line each; a line opens the report in a
 * centred sheet with its review buttons. The Town Hall has no in-tray: its waiting items are the decision queue at the
 * hydrant (DecisionQueue.tsx); a link to the Town Hall in-tray opens the queue (room.ts redirectPanel).
 */
export function IntrayPanel({ buildingId }: { buildingId: string }) {
  const b = useTown((s) => s.buildings.find((x) => x.id === buildingId));
  const agents = useTown((s) => s.agents);
  const rev = useTown((s) => s.rev);
  useTown((s) => s.me);
  // refetch whenever the count on the building changes (WS `building`) or any doc arrives
  const list = useLoad(() => api().intray(buildingId), [buildingId, b?.intray, rev]);
  const [openId, setOpenId] = useState<string | null>(null);
  // the line last opened: still marked in the list after its sheet closes
  const [sel, setSel] = useState<string | null>(null);
  const canReview = store.can("building.review", buildingId);
  const reports = useMemo(() => [...(list.data?.reports ?? [])].sort((x, y) => x.createdAt.localeCompare(y.createdAt)), [list.data]);
  useEffect(() => { if (list.data) store.putDocs(list.data.reports); }, [list.data]);
  const stored = useTown((s) => (openId ? s.docs[openId] : undefined));
  const open = openId ? reports.find((d) => d.id === openId) ?? stored ?? null : null;
  const openFromList = (id: string) => {
    setSel(id); setOpenId(id);
    if (!store.state.docs[id]) void api().doc(id).then((d) => store.putDocs([d])).catch((e: Error) => store.toast(e.message, "bad"));
  };
  if (!b) return <PanelShell title="In-tray"><Empty>No building with id {buildingId}.</Empty></PanelShell>;
  const manager = b.managerAgentId ? agents[b.managerAgentId] : undefined;
  const subtitle = `${b.name} · manager's desk · worked by ${manager ? `★ ${manager.name}` : "you"}`;
  const flags = reports.filter((d) => d.type === "flag").length;
  const count = reports.length - flags;
  return (
    <PanelShell icon={<Glyph kind="intray" />} title={<>In-tray {count ? <Pill tone="warn" title="Reports waiting">{count}</Pill> : null}{flags ? <> <Pill tone="warn" title="Flags humans planted here, waiting for the manager to delegate">⚑ {flags}</Pill></> : null}</>} subtitle={subtitle}>
      {open ? <DocSheet doc={open} review onClose={() => setOpenId(null)} onDecided={() => { setOpenId(null); list.reload(); }} /> : null}
      {!canReview ? <div className="callout">You can read the in-tray. Decisions are for the building's manager.</div> : null}
      {manager ? <div className="callout">★ {manager.name}, the building's manager, works this in-tray and rolls up to the decision queue at the Town Hall. You can still decide here.</div> : null}
      <ErrorLine error={list.error} />
      {list.loading && !list.data ? <Loading /> : !reports.length ? <Empty>The in-tray is empty. When the manager or a fork finishes a session, its report lands here and that agent goes idle; a flag you plant (F on the map) lands here too.</Empty> : (
        <div className="doc-list">
          {reports.map((d) => <CompactLine key={d.id} selected={sel === d.id} lead={<ReportLead doc={d} forkOf={list.data?.chains?.[d.id]?.forkOf} />} title={d.title} at={d.createdAt} pill={reportPill(d)} onOpen={() => openFromList(d.id)} />)}
        </div>
      )}
      <ThreadEntries entries={list.data?.entries ?? []} canReview={canReview} onDecided={() => list.reload()} />
    </PanelShell>
  );
}

/**
 * "Rank now" (it was "Daily digest", Mitchell 1:1 mt_i50xwu4z2t; legible delegation step 5): runs the Secretary's
 * ranking now (core pressRank): it orders the open asks and files the money slate; only for a human who may decide its
 * retainer. Disabled, with why, while a run is under way or nothing changed since the last ranking. In the decision
 * queue's head.
 */
export function DailyDigestButton({ run, onStarted }: { run: DigestRunView | null; onStarted?: () => void }) {
  if (!run) return null;
  const go = async () => {
    await api().runRank();
    store.toast("The Secretary is ranking the asks: the order and the money slate land here in a few minutes.", "ok");
    onStarted?.();
  };
  const label = run.runningId ? "Ranking…" : "Rank now";
  return <Act small run={go} disabled={!!run.refused} title={run.refused ? `Not now: ${run.refused}` : "Run the Secretary's ranking now: the open asks in order and a money slate (fund, hold, skip); it decides nothing"}>{label}</Act>;
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
        <AttachButton small media={media} />
        <button className="btn sm" onClick={onClose}>Cancel</button>
        <Act small tone="primary" disabled={!text.trim() || media.uploading > 0} run={plant}>Plant</Act>
      </div>
    </div>
  );
}

/** What an entry with no report is, in two words, for its pill. */
function entryKind(e: ThreadEntry): string {
  if (e.moved.kind === "dead-session") return "session ended";
  if (e.moved.decision === "ask-decided") return "answer to an ask";
  if (e.moved.kind === "message") return "message";
  return `${String(e.moved.action ?? "decision")}${e.moved.status ? ` ${String(e.moved.status)}` : ""}`;
}

/**
 * The in-tray's entries that have no report behind them (plan dc_uwx045472m step 5): a session that ended without a
 * report, a human's counter, reject, cut or missed key result, a human's words for the manager. Each opens in place;
 * whoever may review the building answers it: Retry puts a dead session's work back on the queue, Acknowledge takes it in.
 */
function ThreadEntries({ entries, canReview, onDecided }: { entries: ThreadEntry[]; canReview: boolean; onDecided: () => void }) {
  if (!entries.length) return null;
  const answer = (e: ThreadEntry, decision: "approve" | "continue") => async () => { await api().reviewEntry(e.id, { decision, note: "" }); onDecided(); };
  return (
    <Section title={`On the threads (${entries.length})`}>
      <div className="doc-list">
        {entries.map((e) => (
          <details key={e.id} className="doc-row">
            <summary title={e.jobId}><Pill tone="warn">{entryKind(e)}</Pill> {e.note || e.id} <span className="muted">{timeAgo(e.createdAt)}</span></summary>
            {e.body ? <DocText text={e.body} /> : null}
            <div className="muted">Job {e.jobId} · entry {e.id}</div>
            {canReview ? (
              <div className="row">
                {e.moved.kind === "dead-session" && e.assignmentId ? <Act small run={answer(e, "continue")} title="Put the same work back on the queue">Retry</Act> : null}
                <Act small run={answer(e, "approve")} title={e.moved.kind === "dead-session" ? "Drop the work" : "Taken in: nothing follows"}>{e.moved.kind === "dead-session" ? "Drop" : "Acknowledge"}</Act>
              </div>
            ) : null}
          </details>
        ))}
      </div>
    </Section>
  );
}

/** A report line's author: portrait and name (★ for the building's manager; a retired fork shows its manager's sprite). */
function ReportLead({ doc, forkOf }: { doc: Doc; forkOf?: string | null }) {
  const a = useTown((s) => s.agents[doc.authorId] ?? (forkOf ? s.agents[forkOf] : undefined));
  const isManager = useTown((s) => !!doc.buildingId && s.buildings.some((b) => b.id === doc.buildingId && b.kind !== "town-hall" && b.managerAgentId === doc.authorId));
  const author = useNameOf(doc.authorId);
  const name = isManager ? `★ ${author}` : author;
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

/** "→ Lena via <goal>": who a waiting item is routed to (docs/goals.md "Routing"). */
export function RoutedTo({ route }: { route?: IntrayRoute }) {
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

/** A building's name with the building glyph, for rows in the decision queue. */
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
const KR_LINE = 46;

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
  // a closed-as-done grant's per-key-result mark (on its own page: inside that key result's fold, gr_zak30564zh step 5)
  const markActions = (k: (typeof krs)[number]) => closedDone && canFund && signedInHuman && isJudgedKr(k.status) ? (
    <div className="actions">
      {/* met, unverified (closed on code and tests, no live check named): a human who saw it live marks it met */}
      {k.status === "met-unverified" ? <Act small tone="ok" run={mark(k.id, "met")} title="You saw it on the live town: mark it met">Mark met</Act> : null}
      {k.status !== "missed"
        ? <Act small tone="bad" disabled={!note.trim()} run={mark(k.id, "missed")} title={note.trim() ? "It did not ship: mark it missed (queues a postmortem)" : "Say why in the note first"}>Mark missed</Act>
        : <Act small run={mark(k.id, "met")} title="Undo: back to met">Back to met</Act>}
    </div>
  ) : null;
  const planList = (<>
      {/* on the page the key results are numbered under one heading, not "Key result N:" on every line (gr_zak30564zh step 5: ≤200 words) */}
      {onPage && krs.length > 1 ? <div className="grant-krs-head"><b>Key results</b></div> : null}
      <ul className="grant-krs">
        {krs.length ? krs.map((k, i) => (
          <li key={k.id}>
            <b>{onPage && krs.length > 1 ? `${i + 1}.` : `Key result${krs.length > 1 ? ` ${i + 1}` : ""}:`}</b> {krLine(k.text)} <span className="muted">· {krStatusWords(k.status)}{k.due ? ` · due ${k.due}` : ""}</span>
            <details className="kr-more"><summary>{onPage ? "details" : `How to check${k.statusNote ? " · note" : ""}`}</summary>
              {krLine(k.text) !== k.text ? <div className="kr-full">{k.text}</div> : null}
              <div className="muted kr-check">How to check: {k.howToCheck}</div>
              {k.statusNote ? <div className="muted kr-check">{krStatusWords(k.status)}: <DocText text={k.statusNote} /></div> : null}
              {onPage ? markActions(k) : null}
            </details>
            {onPage ? null : markActions(k)}
          </li>
        )) : <li className="muted">No key results yet</li>}
        {g.testingPlan.map((t, i) => <li key={i} className="muted">Test: {t.text}</li>)}
      </ul>
      <GrantSteps grant={g} />
      {onPage ? null : <div className="intray-proposal">Stop when: {g.stopCondition}</div>}
  </>);
  const decision = (closedDone && canFund && signedInHuman && krs.some((k) => k.status === "met" || k.status === "met-unverified") ? (<>
        <div className="muted">Closed as done: its key results are met{krs.some((k) => k.status === "met-unverified") ? " (those marked \"met, unverified\" stand on code and tests: no live check was named)" : ""}. If one did not ship, say why and mark it missed.</div>
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
      ) : onPage ? (<>
        {/* on the grant's own page the decision form folds under one line, Talk beside it (gr_zak30564zh step 5): the page opens on the grant */}
        <details className="grant-fold decide-fold">
          <summary><b>Decide</b>{checkpoint ? "continue, adjust or cut" : canFund ? "fund, counter or reject" : "fund it from your Bank input"}</summary>
          {decideForm(false)}
        </details>
        {footer}
      </>) : decideForm(true));
  function decideForm(withTalk: boolean) {
    return (<>
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
            {withTalk ? talk : null}
          </div>
        </div>
      </>);
  }
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
      {onPage ? null : <div className="doc-row-title" title={g.objective}>{grantName(g)}</div>}
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
      <StepStrip grant={g} />
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
 * The plan's steps, numbered (grant B gr_b5fyqibfx2, kr_snardl39qh): funding queues step 1, each step's report the next.
 * Once funded each step says where its latest assignment stands (queued, running, done, cancelled).
 */
export function GrantSteps({ grant: g }: { grant: Pick<GrantView, "steps" | "stepStates"> }) {
  if (!g.steps?.length) return null;
  return (
    <div className="grant-plan-steps">
      <b>Steps</b> <span className="muted">· funding queues step 1; each step's report queues the next</span>
      <ol className="grant-steps">
        {g.steps.map((st, i) => {
          const word = grantStepWord(g.stepStates?.[i]);
          return <li key={i} title={st.description}>{st.title}{word ? <> <span className={`grant-step-state ${word}`}>· {word}</span></> : null}</li>;
        })}
      </ol>
    </div>
  );
}

/**
 * What a checkpoint shipped (Mitchell 1:1 mt_7b4zc7yja3): one line per key result "✓ shipped / ✗ not shipped / ~ partly:
 * <the note a fork filed> (who)" (grant C: "No evidence filed by the forks" when none did), the grant's own reports, spent vs
 * granted, what a top-up buys (only when a fork filed one), and a close report's Shipped titles. On a proposal
 * (`earlier`) it is the earlier grant the proposal names in `continues` (1:1 mt_z1b38bwg98); none named, no block.
 */
function CheckpointEvidenceBlock({ e, onOpenDoc, earlier }: { e: CheckpointEvidence; onOpenDoc: (id: string) => void; earlier?: boolean }) {
  const topUp = !!(e.topUpTokens && e.whatTopUpBuys.trim());
  return (
    <div className="checkpoint-evidence">
      {earlier ? <div className="muted">Continues the earlier grant <GrantLink id={e.grantId} /> {e.objective}</div> : null}
      {/* grant C (gr_95svkzi4l6): the forks file key-result evidence with their reports; the card assembles from it */}
      {e.filed ? null : <div className="muted">{NO_FORK_EVIDENCE}.</div>}
      <ol className="evidence-krs">
        {e.keyResults.map((k) => <li key={k.id} className={`evidence-${k.verdict}`} title={k.text}>{evidenceKrLine(k)}</li>)}
      </ol>
      {e.reports.length ? (
        <div className="evidence-reports">The grant's reports:
          <ul>{e.reports.map((r) => <li key={r.id}><button className="link" onClick={() => onOpenDoc(r.id)}>{r.title}</button> <span className="muted">· {r.authorName}{r.verdict ? ` · ${r.verdict}` : ""} · {timeAgo(r.at)}</span></li>)}</ul>
        </div>
      ) : null}
      {earlier ? <div>Spent {fmtTokens(e.spentTokens)} of {fmtTokens(e.grantTokens)} {ADJ} granted.</div> : null}
      {topUp ? <div>{topUpLine(e)}</div> : null}
      {e.shipped.length ? <div>Shipped in the {e.reportId ? <button className="link" onClick={() => onOpenDoc(e.reportId!)}>checkpoint report</button> : "checkpoint report"}: {e.shipped.join(" · ")}</div> : null}
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
          <AttachButton media={media} />
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

// ---------- the bulletin board in the town square ----------

/**
 * The bulletin board outside the Town Hall (Mitchell's flag dc_52njv3shp8): humans' notes to each other, newest first.
 * Everyone reads it (guests and agents too); a signed-in human pins a note; its author or a town admin takes it down.
 */
export function BulletinPanel() {
  const rev = useTown((s) => s.rev);
  useTown((s) => s.me); // re-render on sign-in
  const board = useLoad(() => api().bulletinBoard(50), [rev]);
  const notes = { ...board, data: board.data?.docs };
  const [open, setOpen] = useState<Doc | null>(null);
  // read / unread per signed-in human (flag dc_04q4h8s229): opening a note marks it read; the map badge follows the count
  const [read, setRead] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!board.data) return;
    store.putDocs(board.data.docs);
    if (store.state.me && board.data.unread !== undefined) store.set({ bulletinUnread: board.data.unread });
  }, [board.data]);
  const isUnread = (d: BulletinNote) => !!d.unread && !read.has(d.id);
  const unreadLeft = (board.data?.docs ?? []).filter(isUnread).length;
  const markRead = (id: string) => {
    setRead((s) => new Set(s).add(id));
    api().readBulletin(id).then((n) => store.set({ bulletinUnread: n }), () => undefined);
  };
  const openNote = (d: BulletinNote) => { if (isUnread(d)) markRead(d.id); setOpen(d); };
  if (open) return (
    <PanelShell icon={<Glyph kind="bulletin" />} title="Bulletin board" subtitle="In the town square, outside the Town Hall">
      <DocView doc={open} onBack={() => setOpen(null)} backLabel="Bulletin board" />
    </PanelShell>
  );
  return (
    <PanelShell icon={<Glyph kind="bulletin" />} title="Bulletin board" subtitle="In the town square: notes from the people who use this town, to each other. Anyone can read them; sign in to pin one.">
      {canPostBulletin() ? <BulletinForm onPosted={board.reload} /> : null}
      <ErrorLine error={notes.error} />
      {unreadLeft ? (
        <div className="bulletin-unread">
          <span>{unreadLeft} new note{unreadLeft === 1 ? "" : "s"} since you last looked</span>
          <Act small title="Mark every note on the board read" run={async () => {
            setRead(new Set(notes.data?.map((d) => d.id)));
            store.set({ bulletinUnread: await api().readBulletin("all") });
          }}>Mark all read</Act>
        </div>
      ) : null}
      {notes.loading && !notes.data ? <Loading /> : !notes.data?.length ? <Empty>No notes on the bulletin board yet.</Empty> : (
        <div className="doc-list">{notes.data.map((d) => (
          <div key={d.id} className="board-fyi">
            <DocRow doc={d} onOpen={() => openNote(d)} unread={isUnread(d)} />
            {canUnpublish(d) ? <Act small title="Back to its author's drafts" run={async () => {
              const r = await api().takeDownBulletin(d.id);
              store.putDocs([r]);
              store.toast(`"${d.title}" is off the bulletin board`, "ok");
              board.reload();
            }}>Take down</Act> : null}
          </div>
        ))}</div>
      )}
    </PanelShell>
  );
}

/** = core postBulletin's rule: any signed-in human (guests read only). */
export function canPostBulletin(): boolean {
  return !!store.state.me;
}

export function BulletinForm({ onPosted }: { onPosted: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const media = useMediaPaste(setBody);
  return (
    <div className="rules-card bulletin-form">
      <div className="rules-head"><b>Post a note</b><span>pinned in the square for everyone who visits</span></div>
      <form className="form" onSubmit={(e) => e.preventDefault()}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" maxLength={200} />
        <textarea {...media.props} rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Your note. Markdown; paste or drop a picture." aria-label="Body" maxLength={4000} />
        <div className="actions">
          <AttachButton media={media} />
          <Act tone="primary" disabled={!title.trim() || !body.trim()} run={async () => {
            const d = await api().postBulletin({ title: title.trim(), body: body.trim() });
            store.putDocs([d]);
            setTitle(""); setBody("");
            store.toast("Pinned on the bulletin board", "ok");
            onPosted();
          }}>Pin it</Act>
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
  // the doc last opened: still marked in the folder after its sheet closes
  const [sel, setSel] = useState<string | null>(null);
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
  return (
    <>
      {/* a doc is content: it opens in a centred sheet, the folder stays here (grant gr_4csjpgh346) */}
      {open ? <DocSheet doc={open} onClose={() => setOpen(null)} /> : null}
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
          <div className="doc-list">{list.data.docs.map((d) => <DocRow key={d.id} doc={d} selected={sel === d.id} onOpen={() => { setOpen(d); setSel(d.id); }} />)}</div>
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
          <AttachButton media={media} />
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

/** The mod station is moderation only: banning agents. Outbox requests (and an admin's Delete on one) live at the
 * Outbox counter; the station's old "Requests" tab was the moderator gate's approval queue (removed in c68edcf0) and
 * links into it now open the Outbox (redirectPanel, room.ts). Mitchell's flag dc_r7u6bkaei4. */
export function ModStationPanel() {
  const me = useTown((s) => s.me);
  const canBan = store.can("town.ban");
  return (
    <PanelShell icon={<Glyph kind="mod" />} title="Mod station" subtitle={canBan ? "Ban agents that misuse the town" : `Read-only${me ? ` · ${me.user.name} isn't an admin` : ""}`}>
      {() => (
        <>
          <p className="direction">Outbox requests, and deleting one that misuses the town, are at the <button className="link" onClick={() => store.open({ kind: "outbox" })}>Outbox</button>.</p>
          <ModBans can={canBan} />
        </>
      )}
    </PanelShell>
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
