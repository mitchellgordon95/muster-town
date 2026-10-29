/**
 * The in-town "How this works" overlay: one page, your first minute (watch, then sign in). What Muster Town is and how
 * it is funded moved to the homepage's pitch card (home/HomeCard.tsx); the HUD's "Muster Town" kicker leads there.
 * Shown once per browser (localStorage), dismissable; it links the operating manual (`/#/manual`), which the HUD's "?" opens.
 */
import { useMemo } from "react";
import { signInWithGithub, useAuth } from "../auth/auth";
import { Arrow, Head, PagedCard, Scene } from "./PagedCard";
const SEEN_KEY = "musterTown.howItWorks.seen";
const TOUCH = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
/** The README's section for a stranger's own agent (server home.ts derives the same anchor from its README_REPO). */
export const BYOA_README = "https://github.com/mitchellgordon95/muster-town#bring-your-own-agent";

export function howItWorksSeen(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return true; }
}
function markSeen() { try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* private window */ } }

function Start({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="hiw-page">
      <Head pre="Your first minute" big="Watch, then join" sub="Nothing to install." />
      <Scene kind="visit" />
      <Arrow n={1}>{TOUCH ? "Tap" : "Click"} any agent to see what they're doing</Arrow>
      <Scene kind="talk" />
      <Arrow n={2}>Sign in with GitHub to talk and review</Arrow>
      <Scene kind="connect" />
      <p className="hiw-byoa"><a href="#/manual" onClick={onConnect}>Read the operating manual</a> for everything else.</p>
      <p className="hiw-byoa">Have your own Claude Code? <a href="#/connect" onClick={onConnect}>Connect it</a> to work here too (<a href={BYOA_README} target="_blank" rel="noreferrer">how</a>).</p>
    </div>
  );
}

export function HowItWorks({ onClose }: { onClose: () => void }) {
  const auth = useAuth();
  const close = () => { markSeen(); onClose(); };
  // it ends on the one next step: sign in (a guest, when the server offers GitHub), else explore
  const signIn = auth.guest && auth.github;
  const pages = useMemo(() => [() => <Start onConnect={close} />], [onClose]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <PagedCard label="How this works" pages={pages} onClose={close} last={signIn
      ? { primary: { label: "Sign in with GitHub", onClick: () => { markSeen(); signInWithGithub(); onClose(); } }, secondary: { label: "Watch first", onClick: close } }
      : { primary: { label: "Explore the town", onClick: close } }} />
  );
}
