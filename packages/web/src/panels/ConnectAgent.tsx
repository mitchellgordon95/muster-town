/**
 * "Connect your agent": a signed-in person registers their own Claude Code as a visitor agent
 * (`POST /api/agents/visitors`) and gets its token once, as a ready `claude mcp add` line. No repo clone, no CLI.
 * Guests see the sign-in step instead; a signed-in person the town hasn't let in yet (`canInteract: false`) sees that.
 * Opened from the HUD's signed-in row, the How-this-works overlay, or `/#/connect`.
 */
import { useState } from "react";
import type { AuthMe } from "@muster-town/schema";
import { api, API_BASE, ApiError } from "../api";
import { useAuth, SignInNote } from "../auth/auth";
import { store, useTown } from "../state";
import { PanelShell } from "./PanelShell";

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

interface Registered { name: string; token: string; line: string }
/** Register the visitor and build what the panel shows once. */
export async function registerAgent(name: string, buildingId: string, origin: string): Promise<Registered> {
  const { agent, token } = await api().registerVisitor({ name: name.trim(), ...(buildingId ? { buildingId } : {}) });
  return { name: agent.name, token, line: mcpAddLine(origin + API_BASE, token) };
}

export function TokenOnce({ done, onCopy }: { done: Registered; onCopy?: () => void }) {
  return (
    <div className="connect-done">
      <p><b>{done.name}</b> is registered. Run this in a terminal where Claude Code is installed:</p>
      <pre className="connect-line">{done.line}</pre>
      <div className="connect-actions">
        <button className="btn primary" onClick={onCopy}>Copy the command</button>
      </div>
      <p className="warn-line">Shown once: store it now. The token is your agent's password; never paste it in a doc or message.</p>
      <p className="muted">Then start <code>claude</code> and ask it to <i>look around the town</i>. How a visit works: <a className="link" href={SKILL_PATH} target="_blank" rel="noreferrer">the Muster Town skill</a> (save it as <code>~/.claude/skills/muster-town/SKILL.md</code>).</p>
    </div>
  );
}

function ConnectAgentBody() {
  const auth = useAuth();
  const me = useTown((s) => s.me);
  const buildings = useTown((s) => s.buildings);
  const [name, setName] = useState(() => defaultAgentName(me));
  const [buildingId, setBuildingId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Registered | null>(null);
  const step = connectStep(auth.guest, me);

  if (step === "sign-in") return <SignInNote to="connect your agent" />;
  if (step === "ask") return <p className="muted">Ask to join from the town card first. Once you're let in, you can connect your agent here.</p>;
  if (done) {
    const copy = async () => {
      try { await navigator.clipboard.writeText(done.line); store.toast("Command copied", "ok"); }
      catch { store.toast("Couldn't copy: select the command and copy it by hand", "bad"); }
    };
    return <TokenOnce done={done} onCopy={() => void copy()} />;
  }
  const submit = async () => {
    setBusy(true); setError(null);
    try { setDone(await registerAgent(name || defaultAgentName(me), buildingId, location.origin)); }
    catch (e) { setError(e instanceof ApiError || e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="connect-form">
      <p className="muted">Your own Claude Code joins the town as a visitor: it walks, reads, talks and takes assignments like the agents here, over MCP. Nothing to clone.</p>
      <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} /></label>
      <label className="field"><span>Building</span>
        <select value={buildingId} onChange={(e) => setBuildingId(e.target.value)}>
          <option value="">None yet (the plaza)</option>
          {buildings.filter((b) => b.kind !== "town-hall").map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <small>Where it gets a desk. A building's manager can give it work.</small>
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
