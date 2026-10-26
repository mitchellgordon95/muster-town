/**
 * The paper card's shell, shared by the in-town "How this works" overlay and the homepage pitch: a modal dialog with a
 * close ×, one page at a time, and a footer of page dots | Back (or Skip) | an optional secondary | one primary button.
 * Keys stay inside it (Esc closes, ←/→ page) so they don't walk the avatar behind. Plus the page parts (Head, Scene,
 * Arrow): each page reads top to bottom, mostly pixel pictures from hiwScenes.ts.
 */
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { sceneUrl, type SceneKind } from "./hiwScenes";
import "./hiw.css";

export const Scene = ({ kind }: { kind: SceneKind }) => <img className="hiw-scene" src={sceneUrl(kind)} alt="" />;
// a dashed down-arrow with the step's label sitting on it as a pill
export const Arrow = ({ n, children }: { n: number; children: ReactNode }) => (
  <div className="hiw-arrow"><i /><span className="hiw-step"><b className="hiw-n">{n}</b>{children}</span><i className="tip" /></div>
);
export const Head = ({ pre, big, sub }: { pre: string; big: string; sub: string }) => (
  <><span className="hiw-pre">{pre}</span><h2>{big}</h2><p className="hiw-sub">{sub}</p></>
);

export interface CardButton { label: string; onClick: () => void }

/** `last` decides the last page's buttons (the one next step); earlier pages end on Next. */
export function PagedCard({ label, pages, onClose, last }: {
  label: string;
  pages: ComponentType[];
  onClose: () => void;
  last: { primary: CardButton | null; secondary?: CardButton | null };
}) {
  const [page, setPage] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const isLast = page === pages.length - 1;
  const Page = pages[page]!;
  const primary = isLast ? last.primary : { label: "Next", onClick: () => setPage(page + 1) };
  const secondary = isLast ? last.secondary : null;
  return (
    <div className="hiw-backdrop" onClick={onClose}>
      {/* focused, so keys stay here instead of walking the avatar behind the overlay */}
      <div className="hiw" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowRight") setPage((p) => Math.min(pages.length - 1, p + 1));
          else if (e.key === "ArrowLeft") setPage((p) => Math.max(0, p - 1));
        }}>
        <div className="hiw-head">
          <button className="close" onClick={onClose} title="Close (Esc)" aria-label="Close">×</button>
        </div>
        <div className="hiw-body" key={page}><Page /></div>
        <div className="hiw-foot">
          <div className="hiw-dots">{pages.length > 1 ? pages.map((_, i) => <button key={i} className={i === page ? "on" : ""} onClick={() => setPage(i)} aria-label={`Page ${i + 1}`} />) : null}</div>
          {page > 0 ? <button className="btn" onClick={() => setPage(page - 1)}>Back</button> : !isLast ? <button className="btn" onClick={onClose}>Skip</button> : null}
          {secondary ? <button className="btn" onClick={secondary.onClick}>{secondary.label}</button> : null}
          {primary ? <button className="btn primary" onClick={primary.onClick}>{primary.label}</button> : null}
        </div>
      </div>
    </div>
  );
}
