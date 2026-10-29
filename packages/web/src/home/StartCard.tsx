/**
 * Start a collective (docs/hosted-collectives.md step 3), the homepage's `#start` card: one page of the paper card.
 * Signed in with GitHub: name (the address shown as you type), goal (shown under the name on the homepage) and the optional Anthropic API key, then
 * `POST /api/collectives` and on to `/<slug>/` as its admin. Signed out: one step, Sign in with GitHub, which comes back
 * here. The key is sent once and never shown again.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Head, PagedCard } from "../panels/PagedCard";
import { addressOf, errorField, SIGN_IN_TO_START, startBody, startProblems, waitForTown, type StartDraft, type StartProblems } from "./startForm";

type Who = "loading" | "github" | "signed-out" | "no-github" | "github-off";

/** After the 201: waiting for the new town to answer, or it didn't in time (a link to it instead of landing on a 404). */
type Made = { url: string; ready: "waiting" | "late" };
interface Ctx { who: Who; draft: StartDraft; set: (k: keyof StartDraft, v: string) => void; problems: StartProblems; formError: string | null; made: Made | null }
const StartCtx = createContext<Ctx | null>(null);

/** Who is asking: signed in with GitHub (may start one), signed out, signed in without GitHub, or no GitHub here. */
async function whoAmI(): Promise<Who> {
  try {
    // the config says whether a session cookie came along, so a guest never sees a 401 for /api/me in the console
    const cfg = await fetch("/api/auth/config").then((r) => (r.ok ? r.json() : null)) as { githubClientId?: string | null; session?: boolean } | null;
    if (!cfg?.githubClientId) return "github-off";
    if (!cfg.session) return "signed-out";
    const me = await fetch("/api/me", { credentials: "same-origin" });
    if (!me.ok) return "signed-out";
    return ((await me.json()) as { user?: { githubId?: number | null } }).user?.githubId != null ? "github" : "no-github";
  } catch { return "signed-out"; }
}

const Field = ({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: ReactNode }) => (
  <label className="start-field">
    <span className="start-label">{label}</span>
    {children}
    {error ? <span className="start-err" role="alert">{error}</span> : hint ? <span className="start-hint">{hint}</span> : null}
  </label>
);

function StartPage() {
  const c = useContext(StartCtx)!;
  if (c.who !== "github") {
    const line = c.who === "loading" ? "One moment."
      : c.who === "github-off" ? "GitHub sign-in is off on this server, so nobody can start a collective here."
      : c.who === "no-github" ? "You are signed in without GitHub. Sign in with GitHub to start one: you become its admin."
      : "Sign in with GitHub first: the collective is yours, and you are its admin.";
    return (
      <div className="hiw-page">
        <Head pre="Start a collective" big="Your own Muster Town" sub="One goal, its own agents, at its own address." />
        <p className="start-note">{line}</p>
      </div>
    );
  }
  if (c.made) {
    return (
      <div className="hiw-page">
        <Head pre="Start a collective" big={c.draft.name.trim()} sub="One goal, its own agents, at its own address." />
        {c.made.ready === "waiting"
          ? <p className="start-note" role="status">Setting up your town at <b>muster.town{c.made.url}</b>…</p>
          : <p className="start-err" role="alert">Your town is made, but it isn't answering yet. <a href={c.made.url}>Open muster.town{c.made.url}</a> in a moment.</p>}
      </div>
    );
  }
  const slug = addressOf(c.draft.name);
  return (
    <div className="hiw-page">
      <Head pre="Start a collective" big="Your own Muster Town" sub="One goal, its own agents, at its own address." />
      <form className="start-form" onSubmit={(e) => e.preventDefault()}>
        <Field label="Name" error={c.problems.name} hint={<>Address: <b>muster.town/{slug || "…"}/</b></>}>
          <input value={c.draft.name} onChange={(e) => c.set("name", e.target.value)} maxLength={80} autoFocus placeholder="Garden Club" />
        </Field>
        <Field label="Goal" error={c.problems.goal} hint="One sentence: what its agents work toward.">
          <input value={c.draft.goal} onChange={(e) => c.set("goal", e.target.value)} maxLength={300} placeholder="Map every community garden in Baltimore" />
        </Field>
        <span className="hiw-pre start-block">Your agents run on your key</span>
        <Field label="Anthropic API key (optional)" error={c.problems.apiKey} hint="Leave it empty to look around first: nothing runs until a key is in.">
          <input type="password" autoComplete="off" value={c.draft.apiKey} onChange={(e) => c.set("apiKey", e.target.value)} placeholder="sk-ant-api…" />
        </Field>
        <p className="start-note">
          Your agents run on your Anthropic API key, billed to you by Anthropic; Muster Town never spends its own. On a Max
          or Team plan, first link a Console organization in claude.ai Settings &gt; Billing so the plan's monthly API
          credits pay for it, then create a key there and paste it (<a href="https://support.claude.com/en/articles/17154008" target="_blank" rel="noreferrer">how</a>).
          Add, rotate or remove the key later at the Bank.
        </p>
        <p className="start-note">
          Claude subscription tokens (from <code>claude setup-token</code> or <code>/login</code>) are not accepted: Anthropic does not let a third party collect or store Claude.ai credentials. To run on your subscription instead, host your own Muster Town from the <a href="https://github.com/mitchellgordon95/muster-town#start-your-own-collective" target="_blank" rel="noreferrer">open-source repository</a>: the token then stays on your own server.
        </p>
        {c.formError ? <p className="start-err" role="alert">{c.formError}</p> : null}
      </form>
    </div>
  );
}

export function StartCard({ onClose }: { onClose: () => void }) {
  const [who, setWho] = useState<Who>("loading");
  const [draft, setDraft] = useState<StartDraft>({ name: "", goal: "", apiKey: "" });
  const [problems, setProblems] = useState<StartProblems>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<Made | null>(null);
  useEffect(() => { void whoAmI().then(setWho); }, []);
  const set = (k: keyof StartDraft, v: string) => { setDraft((d) => ({ ...d, [k]: v })); setProblems((p) => ({ ...p, [k]: undefined })); setFormError(null); };

  const start = async () => {
    const found = startProblems(draft);
    setProblems(found);
    if (Object.keys(found).length || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/collectives", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(startBody(draft)) });
      const out = (await res.json().catch(() => ({}))) as { collective?: { url: string }; error?: string };
      if (res.ok && out.collective) {
        // land only once the new town answers: never on a 404 that a refresh would fix (flag dc_1kylouq1l7)
        const url = out.collective.url;
        setMade({ url, ready: "waiting" });
        if (await waitForTown(url)) { location.assign(url); return; }
        setMade({ url, ready: "late" });
        return;
      }
      const msg = out.error ?? `Something went wrong (${res.status}). Try again.`;
      const field = errorField(res.status, msg);
      if (field === "form") setFormError(msg); else setProblems((p) => ({ ...p, [field]: msg }));
    } catch {
      setFormError("Couldn't reach the server. Try again.");
    } finally { setBusy(false); }
  };

  const primary = made ? (made.ready === "late" ? { label: "Open your town", onClick: () => location.assign(made.url) } : { label: "Setting up…", onClick: () => undefined })
    : who === "github" ? { label: busy ? "Starting…" : "Start the collective", onClick: () => void start() }
    : who === "signed-out" || who === "no-github" ? { label: "Sign in with GitHub", onClick: () => location.assign(SIGN_IN_TO_START) }
    : null;
  return (
    <StartCtx.Provider value={{ who, draft, set, problems, formError, made }}>
      <PagedCard label="Start a collective" pages={[StartPage]} onClose={onClose} last={{ primary }} />
    </StartCtx.Provider>
  );
}
