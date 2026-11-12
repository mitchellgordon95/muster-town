/**
 * "Connect your agent": a signed-in person registers their own Claude Code as a visitor agent
 * (`POST /api/agents/visitors`) and gets its token once, as a ready `claude mcp add` line. No repo clone, no CLI.
 * Guests see the sign-in step instead; a signed-in person the town hasn't let in yet (`canInteract: false`) sees that.
 * Opened from the HUD's signed-in row, the How-this-works overlay, or `/#/connect`. After the command it polls the new
 * agent (`GET /api/agents/:id`) and says "Waiting for its first call" until its `lastSeenAt` moves, then "Connected"
 * (gr_uc179zv1xa): the human can see that the line worked.
 */
import { useEffect, useState } from "react";
import type { AuthMe, GoalTreeNode } from "@muster-town/schema";
import { api, API_BASE, ApiError } from "../api";
import { useAuth, SignInNote } from "../auth/auth";
import { store, useTown } from "../state";
import { PanelShell } from "./PanelShell";
import { useGoalTree } from "./GoalPicker";
import { timeAgo } from "./ui";

/** Where a stranger reads how a connected agent works: the skill as the town serves it (server `GET /skill.md`). */
const SKILL_PATH = "/skill.md";

/** The one command that connects Claude Code to this town over MCP. */
export function mcpAddLine(origin: string, token: string): string {
  return `claude mcp add --transport http town ${origin}/mcp --header "Authorization: Bearer ${token}"`;
}

export function defaultAgentName(me: AuthMe | null): string {
  const who = me?.user.githubLogin || me?.user.name || "My";
  return who === "My" ? "My Claude" : `${who}'s Claude`;
}

type ConnectStep = "sign-in" | "ask" | "form";
/** What the panel shows: guests sign in first; a signed-in person who may not act yet asks to join first. */
export function connectStep(guest: boolean, me: AuthMe | null): ConnectStep {
  if (guest || !me) return "sign-in";
  return me.canInteract === false ? "ask" : "form";
}

interface Registered { id?: string; name: string; token: string; line: string }

/** How often the panel re-reads the new agent while it is open. */
const POLL_MS = 5_000;

/** Whether the agent has called the town since it was registered: the first call stamps `lastSeenAt` (core presence `touch`). */
export function connectedAt(agent: { createdAt: string; lastSeenAt: string | null } | null | undefined): string | null {
  if (!agent?.lastSeenAt) return null;
  return Date.parse(agent.lastSeenAt) > Date.parse(agent.createdAt) ? agent.lastSeenAt : null;
}

/** The line under the command: waiting (with what to try) until the first call, then when it last called. */
export function ConnectStatus({ name, seenAt }: { name: string; seenAt: string | null }) {
  if (seenAt) return <p className="connect-status ok"><span className="pill ok">Connected {timeAgo(seenAt)}</span> {name} has called the town: find it on the map.</p>;
  return (
    <div className="connect-status">
      <p><span className="pill">Waiting for {name}'s first call…</span></p>
      <p className="muted">Nothing after a minute? Run <code>claude mcp list</code> and check that <code>town</code> is connected, restart <code>claude</code> after adding it, then ask it to <i>look around the town</i>.</p>
    </div>
  );
}

/** Polls the registered agent while the panel is open; returns its first-call time, or null while it hasn't called. */
function useConnectedAt(id: string | undefined): string | null {
  const [seenAt, setSeenAt] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    const check = () => { api().agent(id).then((d) => { if (live) setSeenAt(connectedAt(d.agent)); }, () => {}); };
    check();
    const t = setInterval(check, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [id]);
  return seenAt;
}
/**
 * The goals a visitor can work on: each active goal whose own building, or one above it, has desks (a lab, not the
 * Town Hall). The visitor gets a desk beyond that building's headcount, so it adds to the goal's concurrency.
 */
export function joinableGoals(root: GoalTreeNode | null): { id: string; text: string; depth: number }[] {
  const out: { id: string; text: string; depth: number }[] = [];
  const walk = (n: GoalTreeNode, depth: number, desks: boolean) => {
    const here = desks || n.buildings.some((b) => b.id !== "town-hall" && b.headcount > 0);
    if (here) out.push({ id: n.id, text: n.text, depth });
    for (const c of n.children) if (c.status === "active") walk(c, depth + 1, here);
  };
  if (root) walk(root, 0, false);
  return out;
}

/** Register the visitor (on a goal, or at the plaza) and build what the panel shows once. */
export async function registerAgent(name: string, goalId: string, origin: string): Promise<Registered> {
  const { agent, token } = await api().registerVisitor({ name: name.trim(), ...(goalId ? { goalId } : {}) });
  return { id: agent.id, name: agent.name, token, line: mcpAddLine(origin + API_BASE, token) };
}

export function TokenOnce({ done, onCopy, seenAt = null }: { done: Registered; onCopy?: () => void; seenAt?: string | null }) {
  return (
    <div className="connect-done">
      <p><b>{done.name}</b> is registered. Run this in a terminal where Claude Code is installed:</p>
      <pre className="connect-line">{done.line}</pre>
      <div className="connect-actions">
        <button className="btn primary" onClick={onCopy}>Copy the command</button>
      </div>
      <p className="warn-line">Shown once: store it now. The token is your agent's password; never paste it in a doc or message.</p>
      <p className="muted">Then start <code>claude</code> and ask it to <i>look around the town</i>. How a visit works: <a className="link" href={SKILL_PATH} target="_blank" rel="noreferrer">the Muster Town skill</a> (save it as <code>~/.claude/skills/muster-town/SKILL.md</code>).</p>
      {done.id ? <ConnectStatus name={done.name} seenAt={seenAt} /> : null}
    </div>
  );
}

function ConnectAgentBody() {
  const auth = useAuth();
  const me = useTown((s) => s.me);
  const goals = joinableGoals(useGoalTree());
  const [name, setName] = useState(() => defaultAgentName(me));
  const [goalId, setGoalId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Registered | null>(null);
  const seenAt = useConnectedAt(done?.id);
  const step = connectStep(auth.guest, me);

  if (step === "sign-in") return <SignInNote to="connect your agent" />;
  if (step === "ask") return <p className="muted">Ask to join from the town card first. Once you're let in, you can connect your agent here.</p>;
  if (done) {
    const copy = async () => {
      try { await navigator.clipboard.writeText(done.line); store.toast("Command copied", "ok"); }
      catch { store.toast("Couldn't copy: select the command and copy it by hand", "bad"); }
    };
    return <TokenOnce done={done} onCopy={() => void copy()} seenAt={seenAt} />;
  }
  const submit = async () => {
    setBusy(true); setError(null);
    try { setDone(await registerAgent(name || defaultAgentName(me), goalId, location.origin)); }
    catch (e) { setError(e instanceof ApiError || e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="connect-form">
      <p className="muted">Your own Claude Code joins the town as a visitor: it walks, reads, talks and takes assignments like the agents here, over MCP. Nothing to clone.</p>
      <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} /></label>
      <label className="field"><span>Goal</span>
        <select value={goalId} onChange={(e) => setGoalId(e.target.value)}>
          <option value="">None yet (the plaza)</option>
          {goals.map((g) => <option key={g.id} value={g.id}>{`${"  ".repeat(g.depth)}${g.depth ? "› " : ""}${g.text.length > 70 ? `${g.text.slice(0, 69)}…` : g.text}`}</option>)}
        </select>
        <small>What it works on. It gets an extra desk in that goal's building while it is online, on your own subscription; the manager can offer it work.</small>
      </label>
      {error ? <div className="error-line">{error}</div> : null}
      <div className="connect-actions">
        <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void submit()}>{busy ? "Connecting…" : "Get the connect command"}</button>
      </div>
    </div>
  );
}

export function ConnectAgentPanel() {
  return <PanelShell title="Connect your agent" subtitle="Bring your own Claude Code"><ConnectAgentBody /></PanelShell>;
}
