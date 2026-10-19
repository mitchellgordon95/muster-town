export interface Desk { id: string; name: string; sprite: number; title: string; direction: string; status: DeskStatus; }
export interface Building { id: string; name: string; owner: string; goal?: string; description: string; librarian: { id: string; name: string; sprite: number }; desks: Desk[]; }
export interface Activity { building: string; desk: string; run: number; ts: string; kind: "tool" | "text" | "status"; text: string; }
export interface ReportMeta { desk: string; run: number; started: string; ended: string; verdict: string; decision: string; note: string; title: string; file: string; }
export interface Report extends ReportMeta { body: string; }
export interface DeskStatus { state: "idle" | "working" | "awaiting-review" | "stopped" | "error"; run: number; activity: Activity[]; latestReport?: ReportMeta; error?: string; }
export interface TownState { town?: { name: string; goal: string; tagline?: string }; buildings: Building[]; }

export const api = {
  async town(): Promise<TownState> { return (await fetch("/api/town")).json(); },
  async reports(b: string, d: string): Promise<Report[]> { return (await (await fetch(`/api/reports/${b}/${d}`)).json()).reports; },
  async decide(b: string, d: string, run: number, decision: string, note = "") {
    return (await fetch(`/api/reports/${b}/${d}/${run}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, note }) })).json();
  },
  async start(b: string, d: string, note = "") {
    return (await fetch(`/api/desks/${b}/${d}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note }) })).json();
  },
  async startAll(b: string) { return (await fetch(`/api/desks/${b}/start-all`, { method: "POST" })).json(); },
  async chat(building: string, agent: string, message: string, sessionId?: string): Promise<{ reply: string; sessionId?: string }> {
    return (await fetch(`/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ building, agent, message, sessionId }) })).json();
  },
  async file(b: string, p: string): Promise<{ path: string; content: string }> { return (await fetch(`/api/file/${b}/${p}`)).json(); },
};

type Listener = (msg: any) => void;
export function connectWs(onMsg: Listener): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws: WebSocket;
  const open = () => {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (e) => onMsg(JSON.parse(e.data));
    ws.onclose = () => setTimeout(open, 2000);
  };
  open();
}
