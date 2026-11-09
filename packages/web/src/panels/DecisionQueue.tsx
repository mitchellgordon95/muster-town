/**
 * The decision queue at the Town Hall hydrant (docs/legible-delegation.md §3; Mitchell, 2026-11-09: "the default view
 * should be one ask at a time, in the centered content modal … and chat in the side bar"). It replaced the Town Hall
 * in-tray. A centred sheet whose main column shows ONE item, the front of the queue (queueOrder.ts `queueItems`): an
 * ask with its card and buttons, or a waiting item no ask is about with its own decision row. Deciding it (or the ask
 * retiring) pops the next one in. "Look at the queue" lists one line per item; a click makes that line current. J / K
 * peek at the next or previous item without deciding anything.
 *
 * On open, a human allowed to talk at the Town Hall gets (or returns to) their 1:1 with the Secretary in the side panel,
 * so they can say a decision in their own words beside the item.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { grantName, type DigestRunView, type GrantView, type IntrayRoute } from "@muster-town/schema";
import { api, type Intray } from "../api";
import { store, useTown } from "../state";
import { AskCard } from "./AskCard";
import { slateAsks } from "./asks";
import { buildingOf, currentItem, kindWord, mineAsks, queueItems, stepFrom, waitingSince, type QueueItem } from "./queueOrder";
import { DocView } from "./DocView";
import { FundingView } from "./FundingView";
import { isFunder, type IntrayView } from "./funderFilter";
import { GoalProposalItem } from "./GoalTreePanel";
import { CompactLine, accessTitle, captainTitle, goalProposalTitle } from "./intrayList";
import { UNBLOCK_LINE } from "./keyResults";
import { ClosedLoops, NoticesFeed } from "./NoticesPanel";
import { canTalkAtTownHall, openOneOnOne, secretaryOf } from "./oneOnOne";
import { AccessRow, CaptainRow, DailyDigestButton, GrantRow, RetainerRow, RoutedTo, mineOnly } from "./Places";
import { Glyph } from "./PanelShell";
import { Sheet } from "./Sheet";
import { Empty, ErrorLine, Loading, Pill, timeAgo, useLoad } from "./ui";

/** Walk to the Town Hall hydrant and open the decision queue there (open it at once when there is no walking: a guest, no map). */
export function goToQueue(): void {
  const hall = store.state.buildings.find((b) => b.kind === "town-hall");
  if (!hall || !store.walkTo(`hydrant:${hall.id}`, { kind: "queue" })) store.open({ kind: "queue" });
}

/** The queue sheet over the map: loads the Town Hall's waiting items and opens the Secretary's 1:1 beside it. */
export function DecisionQueue({ onClose }: { onClose: () => void }) {
  const hall = useTown((s) => s.buildings.find((b) => b.kind === "town-hall"));
  const rev = useTown((s) => s.rev);
  const signedIn = useTown((s) => !!s.me);
  const list = useLoad(() => hall ? api().intray(hall.id) : Promise.resolve(null), [hall?.id, hall?.intray, rev]);
  const funderLoad = useLoad(() => signedIn ? api().funderWeek().catch(() => null) : Promise.resolve(null), [signedIn, hall?.intray]);
  useSecretaryChat(hall?.id ?? null);
  if (!hall) return <Sheet label="Decision queue" title="Decision queue" onClose={onClose}><Empty>No Town Hall on this map.</Empty></Sheet>;
  return (
    <DecisionQueueView data={list.data} error={list.error} loading={list.loading && !list.data} funder={isFunder(funderLoad.data) ? funderLoad.data : null}
      onReload={list.reload} onClose={onClose} />
  );
}

/**
 * Open (or return to) the viewer's 1:1 with the Secretary in the side panel, once per opening of the queue, for a human
 * allowed to talk at the Town Hall while a live Secretary exists. The server reuses an open 1:1; a side panel already
 * showing it is left alone. A guest, or a human without the permission, gets the sheet alone.
 */
export function useSecretaryChat(hallId: string | null): void {
  const secretary = useTown((s) => secretaryOf(s.agents, hallId));
  const me = useTown((s) => s.me);
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !hallId || !secretary || !me || !canTalkAtTownHall(hallId)) return;
    done.current = true;
    const open = store.state.panel?.kind === "meeting" ? store.state.meetings[store.state.panel.id ?? ""] : undefined;
    if (open && open.kind === "one-on-one" && open.facilitatorId === secretary.id && open.phase !== "done" && open.phase !== "cancelled") return;
    openOneOnOne(hallId, { agentId: secretary.id }).catch((e: Error) => store.toast(e.message, "bad"));
  }, [hallId, secretary, me]);
}

type Mode = "one" | "list";

/** The queue itself, given the Town Hall's waiting-items read (what the tests render). */
export function DecisionQueueView({ data, error = null, loading = false, funder = null, onReload, onClose }: {
  data: Intray | null; error?: string | null; loading?: boolean; funder?: Parameters<typeof mineOnly>[3]; onReload: () => void; onClose: () => void;
}) {
  const signedIn = useTown((s) => !!s.me);
  useTown((s) => s.me);
  const [viewPick, setView] = useState<IntrayView | null>(null);
  const [mode, setMode] = useState<Mode>("one");
  const [picked, setPicked] = useState<string | null>(null);
  /** an ask's record opened from its card (a grant, retainer, captain or access row, or a doc), shown in place of the card */
  const [record, setRecord] = useState<string | null>(null);
  /** decided here: gone from the queue at once, before the reload confirms it */
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const [sheet, setSheet] = useState<"funding" | "feed" | null>(null);
  const routes: Record<string, IntrayRoute> = data?.routes ?? {};
  const picked2 = viewPick === "funded" && !funder ? null : viewPick;
  const view: IntrayView = signedIn ? picked2 ?? data?.defaultView ?? "all" : "all";
  const allGrants = useMemo(() => [...(data?.grants ?? []), ...(data?.stopped ?? [])], [data]);
  const items = useMemo(() => {
    if (!data) return [];
    const f = <T extends { id: string }>(xs: T[] | undefined) => mineOnly(xs ?? [], routes, view, funder);
    return queueItems({
      asks: mineAsks(data.asks ?? [], routes, view !== "all"),
      reports: f(data.reports), grants: f(data.grants), retainers: f(data.retainers), captains: f(data.captains),
      access: data.access ?? [], goalProposals: f(data.goalProposals), blocked: data.blocked ?? [],
    }, data.asks ?? []).filter((x) => !done.has(x.id));
  }, [data, routes, view, funder, done]);
  const all = data ? queueItems({ asks: data.asks ?? [], reports: data.reports, grants: data.grants, retainers: data.retainers ?? [], captains: data.captains ?? [], access: data.access ?? [], goalProposals: data.goalProposals ?? [], blocked: data.blocked ?? [] }).filter((x) => !done.has(x.id)).length : 0;
  const hidden = Math.max(0, all - items.length);
  const cur = currentItem(items, picked);
  const at = cur ? items.indexOf(cur) : -1;
  useEffect(() => { if (data) store.putDocs(data.reports); }, [data]);

  const decided = (id: string) => {
    setDone((s) => new Set(s).add(id));
    setRecord(null);
    setPicked(null);
    onReload();
  };
  // J / K: peek at the next or previous item; nothing on the keyboard decides
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (mode !== "one" || sheet || e.metaKey || e.ctrlKey || e.altKey || (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT" || el.isContentEditable))) return;
      const k = e.key.toLowerCase();
      if (k !== "j" && k !== "k") return;
      e.preventDefault();
      setRecord(null);
      setPicked(stepFrom(items, cur?.id ?? null, k === "j" ? 1 : -1));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [items, cur, mode, sheet]);

  const slate = data ? slateAsks(data.asks ?? [], allGrants).length : 0;
  const actions = (
    <div className="queue-head actions">
      <DailyDigestButton run={(data?.digestRun ?? null) as DigestRunView | null} onStarted={onReload} />
      {signedIn ? (
        <span className="intray-view">
          <select value={view} aria-label="Show" title={`Mine: items routed to you (the goals you captain and everything under them). All: everything waiting.${funder ? " Funded by me: the items under the goals your money reached this week." : ""}`} onChange={(e) => { setView(e.target.value as IntrayView); setPicked(null); setRecord(null); }}>
            <option value="mine">Mine</option>
            <option value="all">All</option>
            {funder ? <option value="funded">Funded by me</option> : null}
          </select>
          {view !== "all" && hidden ? <span className="muted">{hidden} more under All</span> : null}
        </span>
      ) : null}
    </div>
  );

  let main: ReactNode;
  if (loading) main = <Loading />;
  else if (mode === "list") {
    main = (
      <div className="queue-list">
        <button className="link queue-back" onClick={() => setMode("one")}>← One at a time</button>
        {items.length ? (
          <div className="doc-list" role="list" aria-label="The decision queue">
            {items.map((x) => <CompactLine key={x.id} selected={x.id === cur?.id} lead={<><Pill tone={x.kind === "ask" && x.ask.type === "money" ? "warn" : ""}>{kindWord(x)}</Pill><BuildingName id={buildingOf(x)} /></>}
              title={titleOf(x)} at={waitingSince(x)} onOpen={() => { setPicked(x.id); setRecord(null); setMode("one"); }} />)}
          </div>
        ) : <Empty>Nothing waiting.</Empty>}
      </div>
    );
  } else if (!cur) {
    main = (
      <div className="queue-empty">
        <Empty>Nothing waiting. The firehose is quiet.</Empty>
        <ClosedLoops notices={data?.notices ?? []} />
      </div>
    );
  } else {
    main = (
      <div className="queue-one">
        <div className="queue-pos muted">{at === 0 ? "Front of the queue" : `${at + 1} of ${items.length}`}{items.length > 1 ? " · J / K to peek" : ""}</div>
        {record && cur.kind === "ask"
          ? <RecordView id={record} data={data} allGrants={allGrants} routes={routes} onOpen={(id) => openRecord(id, data, setRecord)} onBack={() => setRecord(null)} onDecided={() => decided(cur.id)} onReload={onReload} />
          : <ItemView item={cur} grants={allGrants} routes={routes} onDecided={() => decided(cur.id)} onReload={onReload} onOpenRecord={(id) => openRecord(id, data, setRecord)} />}
        <button className="link queue-look" onClick={() => setMode("list")}>Look at the queue{items.length > 1 ? ` (${items.length})` : ""}</button>
      </div>
    );
  }
  return (
    <Sheet label="Decision queue" title="Decision queue" sub={`${items.length} waiting`} icon={<Glyph kind="hydrant" />} actions={actions} onClose={onClose} maxWidth={900} className="queue-sheet"
      status={<ErrorLine error={error} />}>
      {main}
      <div className="queue-foot">
        <button className="link" onClick={() => setSheet("funding")} title="The money asks on proposals as a slate: toggle fund or hold and watch the Bank">Funding{slate ? <> <Pill tone="warn">{slate}</Pill></> : null}</button>
        <button className="link" onClick={() => setSheet("feed")} title="What shipped, closed or was verified: nothing to decide">What shipped</button>
      </div>
      {sheet === "funding" ? (
        <Sheet label="Funding" title="Funding" sub="The slate: toggle, then decide each card" onClose={() => setSheet(null)} escFirst maxWidth={860}>
          <FundingView asks={data?.asks ?? []} grants={allGrants} notices={data?.notices} onDecided={onReload} onOpenRecord={(id) => { setSheet(null); openRecord(id, data, setRecord); }} />
        </Sheet>
      ) : sheet === "feed" ? (
        <Sheet label="What shipped" title="What shipped" sub="What shipped, closed and was verified" onClose={() => setSheet(null)} escFirst maxWidth={760}>
          <NoticesFeed />
        </Sheet>
      ) : null}
    </Sheet>
  );
}

/** A queue line's title: the ask's, else the item's own. */
function titleOf(x: QueueItem): string {
  switch (x.kind) {
    case "ask": return x.ask.title;
    case "report": return x.doc.title;
    case "grant": return grantName(x.grant);
    case "retainer": return x.retainer.title;
    case "captain": return captainTitle(x.req);
    case "access": return accessTitle(x.req);
    case "goal": return goalProposalTitle(x.proposal);
    case "blocked": return `${x.blocked.name}: no key results`;
  }
}

function BuildingName({ id }: { id: string | null }) {
  const name = useTown((s) => s.buildings.find((b) => b.id === id)?.name);
  return <span className="muted">{name ?? "Town"}</span>;
}

/**
 * A record named by an ask's card: a grant, retainer, captain or access row in this read, or a doc, opens in place of
 * the card; a grant not in this read opens in the link sheet, a meeting in the side panel.
 */
function openRecord(id: string, data: Intray | null, set: (id: string | null) => void) {
  const prefix = id.split("_")[0];
  if (id.startsWith("mt_")) { store.open({ kind: "meeting", id }); return; }
  if (prefix === "gr" && ![...(data?.grants ?? []), ...(data?.stopped ?? [])].some((g) => g.id === id)) { store.openSheet({ kind: "grant", id }); return; }
  if (!["gr", "sc", "cr", "ar"].includes(prefix ?? "") && !store.state.docs[id]) void api().doc(id).then((d) => store.putDocs([d])).catch((e: Error) => store.toast(e.message, "bad"));
  set(id);
}

/** The item on screen, with its decision buttons. */
function ItemView({ item: x, grants, routes, onDecided, onReload, onOpenRecord }: { item: QueueItem; grants: GrantView[]; routes: Record<string, IntrayRoute>; onDecided: () => void; onReload: () => void; onOpenRecord: (id: string) => void }) {
  if (x.kind === "ask") {
    const a = x.ask;
    return <AskCard key={a.id} ask={a} grant={a.targetKind === "grant" ? grants.find((g) => g.id === a.targetId) : undefined} canDecide={routes[a.targetId ?? ""]?.canDecide} onDecided={onDecided} onOpenRecord={onOpenRecord} />;
  }
  return (
    <div className="queue-item" key={x.id}>
      <div className="queue-item-head"><Pill>{kindWord(x)}</Pill> <BuildingName id={buildingOf(x)} /> <span className="muted">· waiting {timeAgo(waitingSince(x))}</span></div>
      <Row item={x} routes={routes} onDecided={onDecided} onReload={onReload} onOpenDoc={onOpenRecord} />
    </div>
  );
}

function Row({ item: x, routes, onDecided, onReload, onOpenDoc }: { item: QueueItem; routes: Record<string, IntrayRoute>; onDecided: () => void; onReload: () => void; onOpenDoc: (id: string) => void }) {
  const route = routes[x.id];
  switch (x.kind) {
    case "ask": return null;
    case "report": return <DocView doc={x.doc} review onDecided={onDecided} />;
    case "grant": return <GrantRow grant={x.grant} canDecide={route?.canDecide} route={route} onDecided={onDecided} onMarked={onReload} onOpenDoc={onOpenDoc} />;
    case "retainer": return <RetainerRow x={x.retainer} route={route} onDecided={onDecided} onOpenDoc={onOpenDoc} />;
    case "captain": return <CaptainRow req={x.req} route={route} onDecided={onDecided} />;
    case "access": return <AccessRow req={x.req} onDecided={onDecided} />;
    case "goal": return <div className="goal-proposals"><RoutedTo route={route} /><GoalProposalItem p={x.proposal} onDone={onDecided} /></div>;
    case "blocked": return (
      <div className="doc-row intray-row">
        <div className="intray-who"><b>{x.blocked.name}</b>{x.blocked.since ? <span>since {timeAgo(x.blocked.since)}</span> : null}</div>
        <p className="direction">{UNBLOCK_LINE}</p>
        <div className="doc-row-meta">
          <span>{x.blocked.reason.replace(/^blocked: /, "")}</span>
          {store.can("building.manage", x.blocked.buildingId) ? <button className="link" onClick={() => store.open({ kind: "building", id: x.blocked.buildingId, tab: "Goals" })}>Write its key results →</button> : null}
        </div>
      </div>
    );
  }
}

/** An ask's record in place of its card, with the way back. */
function RecordView({ id, data, allGrants, routes, onOpen, onBack, onDecided, onReload }: { id: string; data: Intray | null; allGrants: GrantView[]; routes: Record<string, IntrayRoute>; onOpen: (id: string) => void; onBack: () => void; onDecided: () => void; onReload: () => void }) {
  const doc = useTown((s) => s.docs[id]) ?? data?.reports.find((d) => d.id === id);
  const back = <button className="link queue-back" onClick={onBack}>← Back to the ask</button>;
  const g = allGrants.find((x) => x.id === id);
  const sc = data?.retainers?.find((x) => x.id === id);
  const cr = data?.captains?.find((x) => x.id === id);
  const ar = data?.access?.find((x) => x.id === id);
  const item: QueueItem | null = g ? { kind: "grant", id, grant: g } : sc ? { kind: "retainer", id, retainer: sc } : cr ? { kind: "captain", id, req: cr } : ar ? { kind: "access", id, req: ar } : null;
  return (
    <div className="queue-record">
      {back}
      {item ? <Row item={item} routes={routes} onDecided={onDecided} onReload={onReload} onOpenDoc={onOpen} />
        : doc ? <DocView doc={doc} review onDecided={onReload} /> : <Loading />}
    </div>
  );
}
