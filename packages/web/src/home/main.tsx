/**
 * The homepage bundle (entry home.html; the server copies its tags into the page it renders at /). The list behind
 * the card is server-rendered HTML; this adds the pitch card (first visit, the "How this works" button, `/#about`)
 * and the Start-a-collective card (`#start`), and draws the live town previews into the server-rendered tiles.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { readCollectives } from "./collectives";
import { countHome } from "./funnel";
import { HomeCard, homeCardSeen, markHomeCardSeen } from "./HomeCard";
import { mountPreview } from "./preview";
import { StartCard } from "./StartCard";
import { UptimeBlock } from "../panels/Uptime";
import "../type.css";
import "./home.css";

const collectives = readCollectives();
const wantsCard = () => location.hash === "#about";
// "Start a collective" (home.ts) and sign-in's way back to the form
const wantsStart = () => location.hash === "#start";

function Home() {
  const [open, setOpen] = useState(() => wantsCard() || (!wantsStart() && !homeCardSeen()));
  const [start, setStart] = useState(wantsStart);
  useEffect(() => {
    const onHash = () => { if (wantsCard()) setOpen(true); if (wantsStart()) { setOpen(false); setStart(true); } };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const clearHash = () => { if (wantsCard() || wantsStart()) history.replaceState(null, "", location.pathname + location.search); };
  const close = () => { setOpen(false); clearHash(); };
  if (start) return <StartCard onClose={() => { setStart(false); markHomeCardSeen(); clearHash(); }} />;
  return open ? <HomeCard collectives={collectives} onClose={close} /> : null;
}

// the join funnel's `homeViews` (gr_zoo2cf2zpp): this browser, once per UTC day; the server drops headless checks and crawlers
countHome();

// the server-rendered tiles: live previews; opening one counts as having seen the card, and as `homeTile` (gr_ptle4vvujl)
for (const c of document.querySelectorAll<HTMLCanvasElement>("canvas.tile-map[data-preview]")) mountPreview(c, c.dataset.preview!);
for (const a of document.querySelectorAll<HTMLAnchorElement>("a.tile")) a.addEventListener("click", () => { markHomeCardSeen(); countHome("tile"); });

// the server-rendered "Uptime" line (home.ts #uptime) becomes the public Uptime block (gr_rcj8nkbkbt, kr_ay5wb5wfhd)
const uptime = document.getElementById("uptime");
if (uptime) {
  const fallback = <p className="muted">Measured by UptimeRobot: <a href="/api/uptime">/api/uptime</a></p>;
  createRoot(uptime).render(<StrictMode><UptimeBlock fallback={fallback} /></StrictMode>);
}

const root = document.getElementById("home-card");
if (root) createRoot(root).render(<StrictMode><Home /></StrictMode>);
