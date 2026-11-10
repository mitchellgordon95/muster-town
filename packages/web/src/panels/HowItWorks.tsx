/**
 * The in-town "How this works" overlay: one page, your first minute (watch, then sign in). What Muster Town is and how
 * it is funded moved to the homepage's pitch card (home/HomeCard.tsx); the HUD's "Muster Town" kicker leads there.
 * Shown once per browser (localStorage), dismissable; it links the operating manual (`/#/manual`), which the HUD's "?" opens.
 */
import { useMemo } from "react";
import { signInWithGithub, useAuth } from "../auth/auth";
import { notStarted, notStartedWhy, useWorkingCollective, type WorkingCollective } from "../notStarted";
import { useTown } from "../state";
import { Arrow, Head, PagedCard, Scene } from "./PagedCard";
const SEEN_KEY = "musterTown.howItWorks.seen";
const TOUCH = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
/** The README's section for a stranger's own agent (server home.ts derives the same anchor from its README_REPO). */
const BYOA_README = "https://github.com/mitchellgordon95/muster-town#bring-your-own-agent";

/** Fired when the card closes without signing in ("Watch first", ×): a phone guest's town card folds to one line (hud.tsx). */
export const WATCH_FIRST_EVENT = "muster:watch-first";

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
      <Arrow n={2}>Sign in with GitHub, then ask to join</Arrow>
      <Scene kind="connect" />
      <p className="hiw-byoa"><a href="#/manual" onClick={onConnect}>Read the operating manual</a> for everything else.</p>
      <p className="hiw-byoa">Have your own Claude Code? <a href="#/connect" onClick={onConnect}>Connect it</a> to work here too (<a href={BYOA_README} target="_blank" rel="noreferrer">how</a>).</p>
    </div>
  );
}

/** A never-run collective (gr_a6512x0je1): no agent to click; it says why and points at one that is working. */
function NotStarted({ why, working, onConnect }: { why: string; working: WorkingCollective | null; onConnect: () => void }) {
  return (
    <div className="hiw-page">
      <Head pre="Your first minute" big="Not started yet" sub={`This collective hasn't started: ${why}`} />
      <Scene kind="visit" />
      <Arrow n={1}>Nothing has happened here yet</Arrow>
      <Scene kind="work" />
      <Arrow n={2}>{working ? <>Watch <a href={working.url}>{working.name}</a>, which is working</> : "Come back once its founder has started it"}</Arrow>
      <p className="hiw-byoa"><a href="#/manual" onClick={onConnect}>Read the operating manual</a> for everything else.</p>
    </div>
  );
}

export function HowItWorks({ onClose }: { onClose: () => void }) {
  const auth = useAuth();
  const health = useTown((s) => s.health);
  const neverRan = notStarted(health);
  const working = useWorkingCollective(neverRan);
  const close = () => { markSeen(); dispatchEvent(new Event(WATCH_FIRST_EVENT)); onClose(); };
  // it ends on the one next step: sign in (a guest, when the server offers GitHub), else explore; on a never-run
  // collective, open the one that is working
  const signIn = auth.guest && auth.github;
  const why = notStartedWhy(health);
  const pages = useMemo(() => [neverRan ? () => <NotStarted why={why} working={working} onConnect={close} /> : () => <Start onConnect={close} />], [onClose, neverRan, why, working]); // eslint-disable-line react-hooks/exhaustive-deps
  const last = neverRan
    ? { primary: working ? { label: `Open ${working.name}`, onClick: () => { markSeen(); location.assign(working.url); } } : { label: "Explore the town", onClick: close }, secondary: working ? { label: "Look around here", onClick: close } : undefined }
    : signIn
      ? { primary: { label: "Sign in with GitHub", onClick: () => { markSeen(); signInWithGithub(); onClose(); } }, secondary: { label: "Watch first", onClick: close } }
      : { primary: { label: "Explore the town", onClick: close } };
  return <PagedCard label="How this works" pages={pages} onClose={close} last={last} />;
}
