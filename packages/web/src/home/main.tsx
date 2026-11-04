/**
 * The homepage bundle (entry home.html; the server copies its tags into the page it renders at /). The list behind
 * the card is server-rendered HTML; this adds the pitch card (first visit, the "How this works" button, `/#about`)
 * and the Start-a-collective card (`#start`), and draws the live town previews into the server-rendered tiles.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { readCollectives } from "./collectives";
import { HomeCard, homeCardSeen, markHomeCardSeen } from "./HomeCard";
import { mountPreview } from "./preview";
import { StartCard } from "./StartCard";
import { visitorId } from "../visitor";
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

// the join funnel's `homeViews` (gr_zoo2cf2zpp): this browser, once per UTC day; the server drops headless checks
const visitor = visitorId();
if (visitor) fetch("/api/join-funnel/home", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visitor }) }).catch(() => {});

// the server-rendered tiles: live previews, and opening one counts as having seen the card
for (const c of document.querySelectorAll<HTMLCanvasElement>("canvas.tile-map[data-preview]")) mountPreview(c, c.dataset.preview!);
for (const a of document.querySelectorAll<HTMLAnchorElement>("a.tile")) a.addEventListener("click", markHomeCardSeen);

const root = document.getElementById("home-card");
if (root) createRoot(root).render(<StrictMode><Home /></StrictMode>);
