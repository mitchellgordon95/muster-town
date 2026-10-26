/** Boot (auth, WS, snapshot), layout, global keys, dev hooks. */
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, getApi, isMock, tokenStore, type Socket } from "./api";
import { store, useTown, type PanelKind, type PanelRef } from "./state";
import { layoutEdit } from "./map/layoutEdit";
import { LayoutToolbar } from "./panels/LayoutToolbar";
import { townPlan } from "./map/townPlan";
import { PlanToolbar } from "./panels/PlanToolbar";
import { MapCanvas, mapRenderer, typing } from "./map/MapCanvas";
import { Minimap } from "./map/Minimap";
import type { Target } from "./map/renderer";
import { Hint, Hud, SayBox, Toasts } from "./hud";
import { redeployStatus } from "./redeploy";
import { authStore, forceGuest, loadAuthConfig, takeAuthError, useAuth } from "./auth/auth";
import { AgentPanel } from "./panels/AgentPanel";
import { BuildingPanel } from "./panels/BuildingPanel";
import { LibraryPanel, TrophyPanel } from "./panels/LibraryPanel";
import { OutboxPanel } from "./panels/OutboxPanel";
import { MeetingPanel } from "./panels/MeetingPanel";
import { PlanningPanel } from "./panels/PlanningPanel";
import { BoardPanel, CabinetPanel, IntrayPanel, ModStationPanel, PlantFlag, SchedulePanel } from "./panels/Places";
import { flagTargets } from "./panels/flag";
import { BankPanel } from "./panels/BankPanel";
import { GrantPanel } from "./panels/GrantPanel";
import { HowItWorks, howItWorksSeen } from "./panels/HowItWorks";
import { isDocHash, startDocRoutes } from "./route";

type TownHooks = { teleportTo(agentId: string): boolean; walkTo(placeId: string): boolean; openPanel(kind: PanelKind, id?: string): void; townMap(): void; store: typeof store };

declare global {
  /** dev/test hooks; `agentTown` is the pre-rename alias of `musterTown` (drop in P6) */
  interface Window { musterTown?: TownHooks; agentTown?: TownHooks }
}

type Phase = { k: "booting" } | { k: "login"; error?: string } | { k: "ready" };
let socket: Socket | null = null;
/** set after the first open: a later open is a reconnect (e.g. a redeploy's restart) and refetches the events missed meanwhile */
let wasOpen = false;
/** the server commit this bundle was served with; a reconnect to a server on another commit means this bundle is stale */
let loadedCommit: string | null = null;
let booting: Promise<Phase> | null = null;
/** StrictMode runs effects twice in dev; boot (and the WS) must happen once. */
const bootOnce = () => (booting ??= boot());

/**
 * Who am I: a pasted/dev bearer token, else the GitHub session cookie, else a read-only guest (no token prompt).
 * Guests load the town, open the WS without `auth`, and walk a local-only ghost.
 */
async function boot(): Promise<Phase> {
  const a = await getApi();
  a.health().then((h) => { loadedCommit = h.commit ?? null; }, () => undefined);
  const cfg = await loadAuthConfig();
  authStore.set({ github: !!cfg?.githubClientId });
  const authError = takeAuthError();
  if (authError) store.toast(`GitHub sign-in failed: ${authError}`, "bad");
  const guestOnly = forceGuest();
  let token = guestOnly ? null : tokenStore.get();
  if (!token && !guestOnly) { token = await a.devAdminToken(); if (token) tokenStore.set(token); }
  let tokenRejected = false;
  if (token) {
    try {
      store.set({ me: await a.me() });
    } catch (e) {
      if (!(e instanceof ApiError && (e.status === 401 || e.status === 403))) return { k: "login", error: `Can't reach the server: ${(e as Error).message}` };
      tokenStore.set(null); token = null; tokenRejected = true;
    }
  }
  // no (valid) token: a GitHub session cookie, if any, rides on the same-origin request
  if (!token && !guestOnly && !a.mock) {
    try { store.set({ me: await a.me() }); authStore.set({ session: true }); } catch { /* not signed in */ }
  }
  if (!store.state.me) {
    authStore.set({ guest: true });
    if (tokenRejected) store.toast("That token wasn't accepted. You're browsing as a guest.", "bad");
    a.town().then((snap) => store.applySnapshot(snap), () => undefined);
  }
  connect(token);
  store.onLayoutChanged = () => { a.town().then((s) => store.applySnapshot(s), () => undefined); };
  a.events({ limit: 300 }).then((ev) => store.mergeEvents(ev), () => undefined);
  // the Bank's sign: refetch on bank events and spends (at most every 5 s), and each minute as daily tokens expire
  let bankTimer: ReturnType<typeof setTimeout> | null = null;
  const loadBank = () => { a.bank().then((bank) => store.set({ bank }), () => undefined); };
  store.onBankChanged = () => { bankTimer ??= setTimeout(() => { bankTimer = null; loadBank(); }, 5000); };
  // the runtime's live redeploy view: the HUD checks its event-derived banner against it (a run killed by a restart)
  const loadRedeployLive = () => {
    const after = redeployStatus(store.state.events)?.eventId ?? 0;
    a.redeployLive().then((live) => {
      if ((store.state.redeployLive?.afterEventId ?? -1) <= after) store.set({ redeployLive: { live, afterEventId: after } });
    }, () => undefined);
  };
  store.onRedeployEvent = loadRedeployLive;
  loadRedeployLive();
  loadBank();
  setInterval(loadBank, 60_000);
  return { k: "ready" };
}

/** With a token: `auth` first. Without one, the server signs the socket in from the session cookie, or keeps it a read-only guest. */
function connect(token: string | null, attempt = 0) {
  store.set({ conn: "connecting" });
  let opened = false;
  socket = api().connect({
    onOpen: () => {
      opened = true; if (token) socket?.send({ type: "auth", token }); store.set({ conn: "open" });
      if (wasOpen) { api().events({ limit: 100 }).then((ev) => store.mergeEvents(ev), () => undefined); checkBuild(); }
      wasOpen = true;
    },
    onMessage: (m) => store.receive(m),
    onClose: () => {
      store.set({ conn: "closed" });
      const next = opened ? 0 : attempt + 1;
      setTimeout(() => connect(token, next), Math.min(15000, 1000 * 2 ** next));
    },
  });
}

/**
 * After a reconnect (a redeploy restarted the server): when the server runs a commit other than the one this bundle
 * came from, the tab is stale and would keep showing old UI (and old bugs) until someone reloads by hand. Reload it,
 * unless a person is mid-sentence in a text box: then tell them and leave the text alone.
 */
function checkBuild() {
  api().health().then(({ commit }) => {
    if (!commit || !loadedCommit || commit === loadedCommit) return;
    const el = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null;
    const typing = !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT") && !!el.value;
    if (typing) { store.toast("A new version of the town is live. Reload the page to get it.", "info"); return; }
    location.reload();
  }, () => undefined);
}

function panelWidth() { return Math.round(Math.min(500, Math.max(360, window.innerWidth * 0.36))); }

class PanelBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) { return { error: e.message }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel-body">
        <div className="error-line">This panel crashed: {this.state.error}</div>
        <button className="btn" onClick={() => store.open(null)}>Close</button>
      </div>
    );
  }
}

function PanelHost({ panel }: { panel: PanelRef }) {
  switch (panel.kind) {
    case "agent": return <AgentPanel key={panel.id} id={panel.id!} tab={panel.tab} />;
    case "building": return <BuildingPanel key={panel.id} id={panel.id!} tab={panel.tab} />;
    case "library": return <LibraryPanel docId={panel.docId} />;
    case "trophy": return <TrophyPanel docId={panel.docId} />;
    case "outbox": return <OutboxPanel />;
    case "meeting": return <MeetingPanel key={panel.id} id={panel.id} />;
    case "intray": return <IntrayPanel key={panel.id} buildingId={panel.id!} />;
    case "board": return <BoardPanel key={panel.id} buildingId={panel.id!} />;
    case "cabinet": return <CabinetPanel key={panel.id} buildingId={panel.id!} />;
    case "admin":
    case "planning": return <PlanningPanel tab={panel.tab} />;
    case "bank": return <BankPanel />;
    case "grant": return <GrantPanel key={panel.id} id={panel.id!} />;
    case "schedule": return <SchedulePanel />;
    case "mod": return <ModStationPanel />;
  }
}

export function App() {
  const [phase, setPhase] = useState<Phase>({ k: "booting" });
  const panel = useTown((s) => s.panel);
  const ready = useTown((s) => !!s.grid);
  const [target, setTarget] = useState<Target | null>(null);
  const [saying, setSaying] = useState(false);
  // plant a flag (F): the building I stood in when I pressed it, null outside; undefined = closed
  const [flagHere, setFlagHere] = useState<string | null | undefined>(undefined);
  const buildings = useTown((s) => s.buildings);
  useTown((s) => s.me);
  // human-only: a guest has no roles, and agents don't use the web client
  const canAssign = (id: string) => store.can("building.assign", id);
  const canFlag = flagTargets(buildings, canAssign).length > 0;
  const [pw, setPw] = useState(panelWidth);
  // first visit in this browser: explain the town once it has loaded; the HUD's "?" reopens it.
  // Not over a shared doc link (/#/doc/<id>): the reader came for that doc, and the intro stays unseen for next time.
  const [help, setHelp] = useState(() => !howItWorksSeen() && !isDocHash());
  const sayRef = useRef<HTMLInputElement>(null);

  useEffect(() => { bootOnce().then(setPhase, (e) => setPhase({ k: "login", error: String(e) })); }, []);
  useEffect(() => { const r = () => setPw(panelWidth()); window.addEventListener("resize", r); return () => window.removeEventListener("resize", r); }, []);
  useEffect(() => {
    window.musterTown = window.agentTown = {
      teleportTo: (id) => mapRenderer()?.teleportTo(id) ?? false,
      walkTo: (placeId) => store.walkTo(placeId),
      openPanel: (kind, id) => store.open(kind === "library" && id ? { kind, docId: id } : { kind, id }),
      townMap: () => mapRenderer()?.openFlow(),
      store,
    };
  }, []);
  useEffect(() => (ready ? startDocRoutes() : undefined), [ready]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (layoutEdit.draft || townPlan.draft) return; // the map handles keys while editing a layout or planning
      if (e.key === "Escape") {
        if (typing()) (document.activeElement as HTMLElement).blur();
        else if (store.state.panel) store.open(null);
      } else if (e.key === "Enter" && !typing() && !e.repeat) {
        e.preventDefault(); setSaying(true); setTimeout(() => sayRef.current?.focus(), 0);
      } else if (e.key.toLowerCase() === "f" && !typing() && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !authStore.get().guest
        && flagTargets(store.state.buildings, (id) => store.can("building.assign", id)).length) {
        e.preventDefault(); setFlagHere(mapRenderer()?.buildingHere ?? null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const { guest } = useAuth();
  // a guest's ghost is local-only: nothing is sent
  const onMove = useCallback((x: number, y: number) => { if (!authStore.get().guest) socket?.send({ type: "human.move", x, y }); }, []);
  const say = useCallback((text: string) => {
    if (authStore.get().guest) { store.toast("Sign in to talk.", "bad"); return; }
    socket?.send({ type: "human.say", text });
    store.said.set(store.avatarId ?? "__me", { text, at: performance.now() });
  }, []);

  if (phase.k === "login") return <Login error={phase.error} onDone={() => { location.href = import.meta.env.BASE_URL; }} onCancel={authStore.get().guest ? () => setPhase({ k: "ready" }) : undefined} />;
  return (
    <div className="app">
      <MapCanvas panelInset={panel ? pw : 0} onTarget={setTarget} onMove={onMove} />
      {!ready ? <div className="loading-screen"><div className="spin big" /><div>Entering town…</div></div> : null}
      <Hud onPasteToken={() => setPhase({ k: "login" })} onHelp={() => setHelp(true)} />
      <Minimap />
      <div className="bottom" style={{ right: panel ? pw : 0 }}>
        <Hint target={target} saying={saying || flagHere !== undefined} canFlag={canFlag && !guest} />
        {flagHere !== undefined && canFlag && !guest ? <div className="flag-box"><PlantFlag targets={flagTargets(buildings, canAssign, flagHere)} onClose={() => setFlagHere(undefined)} /></div> : null}
        {saying && !guest ? <SayBox inputRef={sayRef} onSend={say} onCancel={() => setSaying(false)} /> : null}
      </div>
      {panel ? <aside className="panel" style={{ width: pw }}><PanelBoundary key={`${panel.kind}:${panel.id ?? ""}:${panel.docId ?? ""}`}><PanelHost panel={panel} /></PanelBoundary></aside> : null}
      <LayoutToolbar />
      <PlanToolbar />
      <Toasts />
      {help && ready ? <HowItWorks onClose={() => setHelp(false)} /> : null}
      {isMock ? <div className="mock-badge" title="VITE_MOCK=1: in-memory fake server">mock</div> : null}
    </div>
  );
}

function Login({ error, onDone, onCancel }: { error?: string; onDone: () => void; onCancel?: () => void }) {
  const [t, setT] = useState("");
  return (
    <div className="login">
      <form onSubmit={(e) => { e.preventDefault(); if (t.trim()) { tokenStore.set(t.trim()); onDone(); } }}>
        <h1>Muster Town</h1>
        <p>Paste your access token. The server prints the admin token at startup and writes it to <code>data/admin-token</code>.</p>
        {error ? <div className="error-line">{error}</div> : null}
        <input autoFocus type="password" value={t} onChange={(e) => setT(e.target.value)} placeholder="Token" />
        <button className="btn primary" disabled={!t.trim()}>Enter town</button>
        {onCancel ? <button type="button" className="btn" onClick={onCancel}>Back to town (guest)</button> : null}
      </form>
    </div>
  );
}
