/**
 * The homepage bundle (entry home.html; the server copies its tags into the page it renders at /). The list behind
 * the card is server-rendered HTML; this adds the pitch card (first visit, the "How this works" button, `/#about`)
 * and draws the live town previews into the server-rendered tiles.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { readCollectives } from "./collectives";
import { HomeCard, homeCardSeen, markHomeCardSeen } from "./HomeCard";
import { mountPreview } from "./preview";
import "./home.css";

const collectives = readCollectives();
const wantsCard = () => location.hash === "#about";

function Home() {
  const [open, setOpen] = useState(() => wantsCard() || !homeCardSeen());
  useEffect(() => {
    const onHash = () => { if (wantsCard()) setOpen(true); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const close = () => {
    setOpen(false);
    if (wantsCard()) history.replaceState(null, "", location.pathname + location.search);
  };
  return open ? <HomeCard collectives={collectives} onClose={close} /> : null;
}

// the server-rendered tiles: live previews, and opening one counts as having seen the card
for (const c of document.querySelectorAll<HTMLCanvasElement>("canvas.tile-map[data-preview]")) mountPreview(c, c.dataset.preview!);
for (const a of document.querySelectorAll<HTMLAnchorElement>("a.tile")) a.addEventListener("click", markHomeCardSeen);

const root = document.getElementById("home-card");
if (root) createRoot(root).render(<StrictMode><Home /></StrictMode>);
