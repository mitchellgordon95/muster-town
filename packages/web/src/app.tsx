/** Boot (auth, WS, snapshot), layout, global keys, dev hooks. */
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, getApi, isMock, tokenStore, type Socket } from "./api";
import { store, useTown, type PanelKind, type PanelRef } from "./state";
import { MapCanvas, mapRenderer, typing } from "./map/MapCanvas";
import type { Target } from "./map/renderer";
import { Hint, Hud, SayBox, Toasts } from "./hud";
import { AgentPanel } from "./panels/AgentPanel";
import { BuildingPanel } from "./panels/BuildingPanel";
import { LibraryPanel, TrophyPanel } from "./panels/LibraryPanel";
import { OutboxPanel } from "./panels/OutboxPanel";
import { MeetingPanel } from "./panels/MeetingPanel";
import { PlanningPanel } from "./panels/PlanningPanel";
import { BoardPanel, CabinetPanel, DonationPanel, IntrayPanel, ModStationPanel, SchedulePanel } from "./panels/Places";

declare global {
  interface Window { agentTown?: { teleportTo(agentId: string): boolean; walkTo(placeId: string): boolean; openPanel(kind: PanelKind, id?: string): void; store: typeof store } }
}

type Phase = { k: "booting" } | { k: "login"; error?: string } | { k: "ready" };
let socket: Socket | null = null;
let booting: Promise<Phase> | null = null;
/** StrictMode runs effects twice in dev; boot (and the WS) must happen once. */
const bootOnce = () => (booting ??= boot());

async function boot(): Promise<Phase> {
  const a = await getApi();
  let token = tokenStore.get();
  if (!token) { token = await a.devAdminToken(); if (token) tokenStore.set(token); }
  if (!token) return { k: "login" };
  try {
    store.set({ me: await a.me() });
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) { tokenStore.set(null); return { k: "login", error: "That token wasn't accepted." }; }
    return { k: "login", error: `Can't reach the server: ${(e as Error).message}` };
  }
  connect(token);
  store.onLayoutChanged = () => { a.town().then((s) => store.applySnapshot(s), () => undefined); };
  a.events({ limit: 300 }).then((ev) => store.mergeEvents(ev), () => undefined);
  return { k: "ready" };
}

function connect(token: string, attempt = 0) {
  store.set({ conn: "connecting" });
  let opened = false;
  socket = api().connect({
    onOpen: () => { opened = true; socket?.send({ type: "auth", token }); store.set({ conn: "open" }); },
    onMessage: (m) => store.receive(m),
    onClose: () => {
      store.set({ conn: "closed" });
      const next = opened ? 0 : attempt + 1;
      setTimeout(() => connect(token, next), Math.min(15000, 1000 * 2 ** next));
    },
  });
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
    case "donation": return <DonationPanel />;
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
  const [pw, setPw] = useState(panelWidth);
  const sayRef = useRef<HTMLInputElement>(null);

  useEffect(() => { bootOnce().then(setPhase, (e) => setPhase({ k: "login", error: String(e) })); }, []);
  useEffect(() => { const r = () => setPw(panelWidth()); window.addEventListener("resize", r); return () => window.removeEventListener("resize", r); }, []);
  useEffect(() => {
    window.agentTown = {
      teleportTo: (id) => mapRenderer()?.teleportTo(id) ?? false,
      walkTo: (placeId) => store.walkTo(placeId),
      openPanel: (kind, id) => store.open(kind === "library" && id ? { kind, docId: id } : { kind, id }),
      store,
    };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (typing()) (document.activeElement as HTMLElement).blur();
        else if (store.state.panel) store.open(null);
      } else if (e.key === "Enter" && !typing() && !e.repeat) {
        e.preventDefault(); setSaying(true); setTimeout(() => sayRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const onMove = useCallback((x: number, y: number) => socket?.send({ type: "human.move", x, y }), []);
  const say = useCallback((text: string) => {
    socket?.send({ type: "human.say", text });
    store.said.set(store.avatarId ?? "__me", { text, at: performance.now() });
  }, []);

  if (phase.k === "login") return <Login error={phase.error} onDone={() => { booting = null; setPhase({ k: "booting" }); bootOnce().then(setPhase); }} />;
  return (
    <div className="app">
      <MapCanvas panelInset={panel ? pw : 0} onTarget={setTarget} onMove={onMove} />
      {!ready ? <div className="loading-screen"><div className="spin big" /><div>Entering town…</div></div> : null}
      <Hud />
      <div className="bottom" style={{ right: panel ? pw : 0 }}>
        <Hint target={target} saying={saying} />
        {saying ? <SayBox inputRef={sayRef} onSend={say} onCancel={() => setSaying(false)} /> : null}
      </div>
      {panel ? <aside className="panel" style={{ width: pw }}><PanelBoundary key={`${panel.kind}:${panel.id ?? ""}:${panel.docId ?? ""}`}><PanelHost panel={panel} /></PanelBoundary></aside> : null}
      <Toasts />
      {isMock ? <div className="mock-badge" title="VITE_MOCK=1: in-memory fake server">mock</div> : null}
    </div>
  );
}

function Login({ error, onDone }: { error?: string; onDone: () => void }) {
  const [t, setT] = useState("");
  return (
    <div className="login">
      <form onSubmit={(e) => { e.preventDefault(); if (t.trim()) { tokenStore.set(t.trim()); onDone(); } }}>
        <h1>Agent Town</h1>
        <p>Paste your access token. The server prints the admin token at startup and writes it to <code>data/admin-token</code>.</p>
        {error ? <div className="error-line">{error}</div> : null}
        <input autoFocus type="password" value={t} onChange={(e) => setT(e.target.value)} placeholder="Token" />
        <button className="btn primary" disabled={!t.trim()}>Enter town</button>
      </form>
    </div>
  );
}
