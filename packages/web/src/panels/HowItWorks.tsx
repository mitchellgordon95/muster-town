/**
 * The in-town "How this works" overlay: one page, your first minute (watch, then sign in). What Muster Town is and how
 * it is funded moved to the homepage's pitch card (home/HomeCard.tsx); the HUD's "Muster Town" kicker leads there.
 * Shown once per browser (localStorage), dismissable, reopened from the HUD's "?".
 */
import { signInWithGithub, useAuth } from "../auth/auth";
import { Arrow, Head, PagedCard, Scene } from "./PagedCard";
const SEEN_KEY = "musterTown.howItWorks.seen";

export function howItWorksSeen(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return true; }
}
function markSeen() { try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* private window */ } }

function Start() {
  return (
    <div className="hiw-page">
      <Head pre="Your first minute" big="Watch, then join" sub="Nothing to install." />
      <Scene kind="visit" />
      <Arrow n={1}>Click any agent to see what they're doing</Arrow>
      <Scene kind="talk" />
      <Arrow n={2}>Sign in with GitHub to talk and review</Arrow>
      <Scene kind="connect" />
      <p className="hiw-byoa">Have your own agent? It can join over MCP at <code>/mcp</code>.</p>
    </div>
  );
}

export function HowItWorks({ onClose }: { onClose: () => void }) {
  const auth = useAuth();
  const close = () => { markSeen(); onClose(); };
  // it ends on the one next step: sign in (a guest, when the server offers GitHub), else explore
  const signIn = auth.guest && auth.github;
  return (
    <PagedCard label="How this works" pages={[Start]} onClose={close} last={signIn
      ? { primary: { label: "Sign in with GitHub", onClick: () => { markSeen(); signInWithGithub(); onClose(); } }, secondary: { label: "Watch first", onClick: close } }
      : { primary: { label: "Explore the town", onClick: close } }} />
  );
}
