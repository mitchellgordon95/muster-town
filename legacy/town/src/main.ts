import Phaser from "phaser";
import { api, connectWs, type TownState } from "./api";
import { TownScene } from "./scene";
import { Panel } from "./panel";

const hud = document.getElementById("hud")!;
const hint = document.getElementById("hint")!;

function renderHud(state: TownState & { town?: { name: string; goal: string } }) {
  const t = state.town ?? { name: "Agent Town", goal: "" };
  const rows = state.buildings.map((b) => {
    const c: Record<string, number> = {};
    for (const d of b.desks) c[d.status.state] = (c[d.status.state] ?? 0) + 1;
    const bits = Object.entries(c).map(([k, v]) => `<span class="state ${k}">${v} ${k}</span>`).join(" ");
    const idle = b.desks.filter((d) => d.status.state === "idle" && !d.status.latestReport).length;
    return `<div style="margin-top:6px"><b>${b.name}</b><br>${bits}${idle ? `<br><button class="btn ok" data-start="${b.id}">Start all ${idle} idle desks</button>` : ""}</div>`;
  }).join("");
  hud.innerHTML = `<h1>${t.name}</h1>${t.goal ? `<div style="color:var(--warn);font-weight:600">🎯 ${t.goal}</div>` : ""}${rows}<div class="muted" style="margin-top:8px">Arrows / WASD to walk · E to talk · Esc closes panel</div>`;
  hud.querySelectorAll<HTMLButtonElement>("button[data-start]").forEach((btn) => {
    btn.onclick = async () => { btn.disabled = true; await api.startAll(btn.dataset.start!); await refresh(); };
  });
}

let scene: TownScene;
const panel = new Panel();
async function refresh() {
  const s = await api.town();
  renderHud(s); scene?.applyState(s); panel.applyState(s);
}
panel.onChange = refresh;

async function boot() {
  const state = await api.town();
  renderHud(state);
  scene = new TownScene(state);
  scene.onInteract = (ref) => panel.open(ref);
  scene.onHint = (t) => { hint.style.display = t ? "block" : "none"; hint.textContent = t ?? ""; };
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    pixelArt: true,
    backgroundColor: "#14151c",
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    scene: [scene],
  });
  connectWs((msg) => {
    if (msg.type === "state") { renderHud(msg); scene.applyState(msg); panel.applyState(msg); }
    else if (msg.type === "activity") { scene.applyActivity(msg); panel.applyActivity(msg); }
  });
}
void boot().then(() => { (window as any).agentTown = { get scene() { return scene; }, panel, refresh }; });
