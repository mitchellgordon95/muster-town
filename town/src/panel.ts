import { marked } from "marked";
import { api, type Report, type Activity, type TownState, type Desk, type Building } from "./api";
import type { AgentRef } from "./scene";

const $ = (id: string) => document.getElementById(id)!;

export class Panel {
  private ref?: AgentRef;
  private tab = "";
  private chatLog = new Map<string, { me: boolean; text: string }[]>();
  private sessions = new Map<string, string>();
  private el = $("panel");
  onChange?: () => void;

  constructor() {
    $("p-close").onclick = () => this.close();
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") this.close(); });
    $("body").addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("a") as HTMLAnchorElement | null;
      if (!a || !this.ref) return;
      const href = a.getAttribute("href") || "";
      if (/^https?:/.test(href)) { a.target = "_blank"; return; }
      e.preventDefault();
      const base = (a.closest("[data-base]") as HTMLElement | null)?.dataset.base ?? "";
      this.showFile(resolvePath(base, href.split("#")[0]));
    });
  }

  get isOpen() { return this.el.classList.contains("open"); }
  get key() { return this.ref ? `${this.ref.building.id}/${this.ref.desk?.id ?? "librarian"}` : ""; }

  open(ref: AgentRef) {
    this.ref = ref;
    this.el.classList.add("open");
    this.renderHeader();
    this.setTab(this.tab && this.tabs().includes(this.tab) ? this.tab : (ref.desk ? (ref.desk.status.state === "awaiting-review" ? "Report" : "Activity") : "About"));
  }
  close() { this.el.classList.remove("open"); (document.activeElement as HTMLElement)?.blur(); }

  /** Refresh current ref from a new town state. */
  applyState(state: TownState) {
    if (!this.ref) return;
    const b = state.buildings.find((x) => x.id === this.ref!.building.id);
    if (!b) return;
    const d = this.ref.desk ? b.desks.find((x) => x.id === this.ref!.desk!.id) : undefined;
    const prevState = this.ref.desk?.status.state;
    this.ref = this.ref.desk ? { building: b, desk: d } : { building: b, librarian: true };
    this.renderHeader();
    if (this.isOpen && prevState !== d?.status.state && this.tab !== "Chat") this.setTab(this.tab);
  }
  applyActivity(a: Activity) {
    if (!this.isOpen || this.key !== `${a.building}/${a.desk}` || this.tab !== "Activity") return;
    const feed = $("body").querySelector(".feed");
    if (feed) { feed.appendChild(feedLine(a)); feed.scrollTop = feed.scrollHeight; $("body").scrollTop = $("body").scrollHeight; }
  }

  private tabs() { return this.ref?.desk ? ["Activity", "Report", "Chat", "Article"] : ["About", "Chat", "Wiki"]; }

  private renderHeader() {
    const r = this.ref!;
    if (r.desk) {
      $("p-name").innerHTML = `${r.desk.name} <span class="state ${r.desk.status.state}">${r.desk.status.state}</span>`;
      $("p-role").textContent = `${r.desk.title} · ${r.building.name}`;
    } else {
      $("p-name").textContent = r.building.librarian.name;
      $("p-role").textContent = `Librarian · ${r.building.name}`;
    }
    const nav = $("tabs"); nav.innerHTML = "";
    for (const t of this.tabs()) {
      const b = document.createElement("button"); b.textContent = t; b.className = t === this.tab ? "active" : "";
      b.onclick = () => this.setTab(t); nav.appendChild(b);
    }
  }

  private setTab(t: string) {
    this.tab = t;
    for (const b of $("tabs").querySelectorAll("button")) b.classList.toggle("active", b.textContent === t);
    const body = $("body"); body.innerHTML = "";
    const r = this.ref!;
    if (t === "Activity") this.renderActivity(body, r.desk!);
    else if (t === "Report") void this.renderReport(body, r.building, r.desk!);
    else if (t === "Chat") this.renderChat(body);
    else if (t === "Article") void this.showFile(`wiki/desks/${r.desk!.id}.md`);
    else if (t === "About") this.renderAbout(body, r.building);
    else if (t === "Wiki") void this.showFile("wiki/main.md");
  }

  private renderActivity(body: HTMLElement, d: Desk) {
    const intro = document.createElement("p");
    intro.innerHTML = `<b>Direction:</b> ${esc(d.direction)}`;
    body.appendChild(intro);
    if (d.status.error) { const e = document.createElement("p"); e.style.color = "var(--bad)"; e.textContent = `Error: ${d.status.error}`; body.appendChild(e); }
    const feed = document.createElement("div"); feed.className = "feed";
    if (!d.status.activity.length) feed.innerHTML = `<div>No activity yet.</div>`;
    for (const a of d.status.activity) feed.appendChild(feedLine(a));
    body.appendChild(feed);
    body.scrollTop = body.scrollHeight;
  }

  private async renderReport(body: HTMLElement, b: Building, d: Desk) {
    const reports = await api.reports(b.id, d.id);
    body.innerHTML = "";
    const st = d.status;
    const actions = document.createElement("div"); actions.className = "actions";
    const note = document.createElement("textarea"); note.placeholder = "Optional note to the agent (required for Redirect)"; note.rows = 3;
    const mk = (label: string, cls: string, fn: () => Promise<any>) => {
      const btn = document.createElement("button"); btn.className = `btn ${cls}`; btn.textContent = label;
      btn.onclick = async () => { btn.disabled = true; try { await fn(); } finally { this.onChange?.(); } };
      actions.appendChild(btn);
    };
    if (!reports.length) {
      body.innerHTML = `<p>No runs yet. Start the first run to get a report.</p>`;
      if (st.state === "idle" || st.state === "error") { mk("Start first run", "ok", () => api.start(b.id, d.id, note.value)); body.appendChild(note); body.appendChild(actions); }
      else if (st.state === "working") body.innerHTML += `<p class="state working">Run ${st.run} in progress</p>`;
      return;
    }
    const latest = reports[reports.length - 1];
    const sel = document.createElement("select");
    for (const r of [...reports].reverse()) { const o = document.createElement("option"); o.value = String(r.run); o.textContent = `Run ${r.run} — ${r.title} (${r.verdict} / ${r.decision})`; sel.appendChild(o); }
    body.appendChild(sel);
    const view = document.createElement("div"); view.className = "md"; view.dataset.base = `reports/${d.id}/x.md`;
    body.appendChild(view);
    const show = (r: Report) => {
      view.innerHTML = `<div class="frontmatter">run ${r.run} · verdict <b>${r.verdict}</b> · decision <b>${r.decision}</b>${r.note ? ` · note: ${esc(r.note)}` : ""}<br>${r.started.slice(0, 16)} → ${r.ended.slice(0, 16)}</div>` + marked.parse(r.body) as string;
    };
    show(latest);
    sel.onchange = () => show(reports.find((r) => r.run === Number(sel.value))!);

    if (latest.decision === "pending" && st.state !== "working") {
      const h = document.createElement("p"); h.innerHTML = `<b>Your call on run ${latest.run}</b> (agent says: ${latest.verdict})`;
      body.appendChild(h); body.appendChild(note);
      mk("Approve: continue as proposed", "ok", () => api.decide(b.id, d.id, latest.run, "approve", note.value));
      mk("Redirect with note", "warn", async () => { if (!note.value.trim()) { note.focus(); throw new Error("note required"); } await api.decide(b.id, d.id, latest.run, "redirect", note.value); });
      mk("Stop this desk", "bad", () => api.decide(b.id, d.id, latest.run, "stop", note.value));
      body.appendChild(actions);
    } else if (st.state === "stopped" || st.state === "error" || st.state === "idle") {
      const h = document.createElement("p"); h.innerHTML = st.state === "stopped" ? "<b>Desk is stopped.</b> Restart it with a note to change direction." : "<b>Start the next run.</b>";
      body.appendChild(h); body.appendChild(note);
      mk(st.state === "stopped" ? "Restart desk" : "Start next run", "ok", () => api.start(b.id, d.id, note.value));
      body.appendChild(actions);
    } else if (st.state === "working") {
      const h = document.createElement("p"); h.innerHTML = `<span class="state working">Run ${st.run} in progress</span> — this report is from the previous run.`; body.prepend(h);
    }
  }

  private renderChat(body: HTMLElement) {
    const k = this.key;
    const log = this.chatLog.get(k) ?? [];
    const wrap = document.createElement("div"); wrap.className = "chat";
    const who = this.ref!.desk?.name ?? this.ref!.building.librarian.name;
    if (!log.length) wrap.innerHTML = `<div class="msg them">Hi, I'm ${who}. ${this.ref!.desk ? "Ask me what I'm working on or what I've found." : "I can tell you what this lab is studying, what's been found, and who's waiting on a decision."}</div>`;
    for (const m of log) { const d = document.createElement("div"); d.className = `msg ${m.me ? "me" : "them"}`; d.textContent = m.text; wrap.appendChild(d); }
    body.appendChild(wrap);
    const bar = document.createElement("div"); bar.className = "chatbar";
    const ta = document.createElement("textarea"); ta.placeholder = "Say something… (Enter to send, Shift+Enter for newline)";
    const btn = document.createElement("button"); btn.className = "btn ok"; btn.textContent = "Send";
    const send = async () => {
      const text = ta.value.trim(); if (!text) return;
      ta.value = ""; btn.disabled = true;
      const cur = this.chatLog.get(k) ?? []; cur.push({ me: true, text }); this.chatLog.set(k, cur);
      const me = document.createElement("div"); me.className = "msg me"; me.textContent = text; wrap.appendChild(me);
      const them = document.createElement("div"); them.className = "msg them"; them.textContent = "…"; wrap.appendChild(them);
      body.scrollTop = body.scrollHeight;
      try {
        const r = await api.chat(this.ref!.building.id, this.ref!.desk?.id ?? "librarian", text, this.sessions.get(k));
        if (r.sessionId) this.sessions.set(k, r.sessionId);
        them.textContent = r.reply; cur.push({ me: false, text: r.reply });
      } catch (e: any) { them.textContent = `(error: ${e?.message ?? e})`; }
      btn.disabled = false; body.scrollTop = body.scrollHeight; ta.focus();
    };
    btn.onclick = send;
    ta.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } e.stopPropagation(); };
    bar.appendChild(ta); bar.appendChild(btn); body.appendChild(bar);
    ta.focus();
  }

  private renderAbout(body: HTMLElement, b: Building) {
    const counts: Record<string, number> = {};
    for (const d of b.desks) counts[d.status.state] = (counts[d.status.state] ?? 0) + 1;
    body.innerHTML = `<div class="md"><h1>${esc(b.name)}</h1>${b.goal ? `<p><b>Goal:</b> ${esc(b.goal)}</p>` : ""}<p>${esc(b.description)}</p>
      <h2>Desks</h2><ul>${b.desks.map((d) => `<li><b>${esc(d.name)}</b> — ${esc(d.title)} <span class="state ${d.status.state}">${d.status.state}</span>${d.status.latestReport ? ` · run ${d.status.latestReport.run}: ${esc(d.status.latestReport.title)}` : ""}</li>`).join("")}</ul>
      <h2>Files</h2><ul><li><a href="wiki/main.md">wiki/main.md</a></li><li><a href="wiki/next-actions.md">wiki/next-actions.md</a></li><li><a href="AGENTS.md">AGENTS.md</a></li></ul></div>`;
    (body.firstElementChild as HTMLElement).dataset.base = "x.md";
  }

  async showFile(p: string) {
    const body = $("body"); body.innerHTML = `<p class="muted">Loading ${esc(p)}…</p>`;
    const r = await api.file(this.ref!.building.id, p);
    if (!r.content && !r.path) { body.innerHTML = `<p>Not found: ${esc(p)}</p>`; return; }
    body.innerHTML = `<div class="frontmatter">${esc(r.path)}</div><div class="md" data-base="${esc(r.path)}">${marked.parse(stripFrontmatter(r.content))}</div>`;
    body.scrollTop = 0;
  }
}

function feedLine(a: Activity) {
  const d = document.createElement("div"); d.className = a.kind;
  d.innerHTML = `<time>${a.ts.slice(11, 19)}</time>${esc(a.text)}`; return d;
}
function esc(s: string) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!)); }
function stripFrontmatter(s: string) { return s.replace(/^---\n[\s\S]*?\n---\n/, ""); }
function resolvePath(base: string, href: string): string {
  const dir = base.split("/").slice(0, -1);
  for (const seg of href.split("/")) { if (seg === "..") dir.pop(); else if (seg && seg !== ".") dir.push(seg); }
  return dir.join("/");
}
