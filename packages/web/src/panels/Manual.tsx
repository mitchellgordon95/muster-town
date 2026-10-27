/**
 * The operating manual for humans (the HUD's "?", `/#/manual[/<section>]`): the Town Hall article tagged `manual`
 * (GET /api/manual; the repo's docs/manual.md seeds it once) on a scrolling paper sheet, with a table of contents
 * from its h2 headings. Paper, not a dark panel: it explains, it isn't somewhere you work (style guide §1).
 */
import { useEffect, useMemo, useRef } from "react";
import { api } from "../api";
import { store } from "../state";
import { Markdown } from "./Markdown";
import { manualSections } from "./manualSections";
import { useLoad } from "./ui";
import "./hiw.css";

export function ManualSheet({ section }: { section?: string }) {
  const load = useLoad(() => api().manual(), []);
  const parts = useMemo(() => (load.data ? manualSections(load.data.doc.body) : null), [load.data]);
  const sheet = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { sheet.current?.focus(); }, []);
  useEffect(() => {
    if (!parts || !body.current) return;
    const el = section ? body.current.querySelector<HTMLElement>(`[data-slug="${section}"]`) : null;
    body.current.scrollTo({ top: el ? el.offsetTop - 8 : 0 });
  }, [parts, section]);
  const close = () => store.open(null);
  return (
    <div className="hiw-backdrop" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={sheet} className="paper manual" role="dialog" aria-modal="true" aria-label="Operating manual" tabIndex={-1}
        // keys stay here (they'd walk the avatar); Esc closes
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); }}
        // in-town links (`#/connect`, `#/manual/<section>`) go through the hash router
        onClickCapture={(e) => {
          const href = (e.target as HTMLElement).closest("a")?.getAttribute("href") ?? "";
          if (href.startsWith("#/")) { e.preventDefault(); e.stopPropagation(); location.hash = href; }
        }}>
        <div className="manual-head">
          <div>
            <div className="hiw-pre">Muster Town</div>
            <h2>Operating manual</h2>
          </div>
          <button className="close" onClick={close} aria-label="Close">×</button>
        </div>
        <div ref={body} className="manual-body">
          {load.error ? <p className="manual-note">The manual isn't available right now ({load.error}).</p> : null}
          {!parts && !load.error ? <p className="manual-note">Loading…</p> : null}
          {parts ? <>
            {parts.intro ? <Markdown className="manual-md" text={parts.intro} /> : null}
            <nav className="manual-toc" aria-label="Contents">
              {parts.sections.map((s) => (
                <a key={s.slug} href={`#/manual/${s.slug}`} className={s.slug === section ? "on" : ""}>{s.title}</a>
              ))}
            </nav>
            {parts.sections.map((s) => (
              <section key={s.slug} data-slug={s.slug}>
                <h3><a href={`#/manual/${s.slug}`}>{s.title}</a></h3>
                <Markdown className="manual-md" text={s.body} />
              </section>
            ))}
            <p className="manual-note">This manual is a Town Hall document: <a href={`#/doc/${load.data!.doc.id}`}>open it in the library</a>.</p>
          </> : null}
        </div>
      </div>
    </div>
  );
}
