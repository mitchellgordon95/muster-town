/**
 * The centred sheet over the map (grant gr_4csjpgh346, 1:1 mt_0n8ttf1bur: "sidebars function as navigation or detail views,
 * central modals for content"): one shell for every piece of content you read or edit on its own. The Bank (BankSheet.tsx)
 * and the goal editor (GoalTreePanel.tsx) open on it.
 *
 *   ┌ head: icon · title / sub · actions · × ───────────────┐
 *   │ status (an error or loading line, optional)            │
 *   │ tabs │ main (children)          ┊ side (optional)      │
 *   └──────┴──────────────────────────┴──────────────────────┘
 *
 * It leaves `right: var(--panel-w)` for the side panel, so a link from it (a grant, a 1:1) opens beside it. × , Esc (with
 * no side panel open and no field focused) or a mousedown on the backdrop closes it. `side` sits behind a draggable divider
 * whose width is saved under `sideKey` (sideShare is the default width, % of the body). A caller whose main and side share
 * state (the Bank's picked row) lays both out itself with `columns(divider)`: a `.sheet-main` element, the divider, then a
 * `.sheet-side` one. On a phone (≤ 760 px) it is full screen: tabs in a row, main above side, no divider; `phone: "split"`
 * gives main the top 40% and side the rest (each scrolls), `"scroll"` (default) stacks them in one scroll.
 */
import { useEffect, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { store } from "../state";
import { SheetDivider, useSideWidth } from "./panelResize";

export type SheetProps = {
  /** the dialog's aria-label */
  label: string;
  title: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  /** buttons in the head, left of × */
  actions?: ReactNode;
  onClose: () => void;
  /** a line between the head and the body (an error, a loading line) */
  status?: ReactNode;
  /** the tab column on the left (a row on a phone): SheetTabs, or any nav */
  tabs?: ReactNode;
  /** the main column */
  children?: ReactNode;
  mainClass?: string;
  mainLabel?: string;
  /** the side column, behind the divider */
  side?: ReactNode;
  sideClass?: string;
  sideLabel?: string;
  sideRef?: Ref<HTMLElement>;
  /** the side as `<main>` (the goal editor's detail) instead of `<aside>` */
  sideIsMain?: boolean;
  /** lay out main + divider + side yourself (they share state): replaces children/side */
  columns?: (divider: ReactNode) => ReactNode;
  /** where the side's dragged width is saved (localStorage key); required with side or columns */
  sideKey?: string;
  /** the side's default width, % of the body (default 36) */
  sideShare?: number;
  /** the divider's aria-label */
  dividerLabel?: string;
  phone?: "scroll" | "split";
  /** the sheet's max width in px (default 1280) */
  maxWidth?: number;
  /** extra class on the dialog, for content rules scoped to one sheet */
  className?: string;
  /**
   * The sheet belongs to the side panel beside it (an in-tray item, a filing-cabinet doc): Esc closes the sheet first
   * and the panel stays, so you are back on its list. Without it, Esc goes to an open side panel first.
   */
  escFirst?: boolean;
};

/**
 * The open sheets, each with the order it first rendered in: Esc closes only the newest (a link sheet over an in-tray item
 * sheet, a page's frame over its doc). Render order, not effect order: a sheet opened inside another renders after it but
 * runs its effects before it.
 */
const open = new Set<{ seq: number }>();
let seqNext = 0;
/** A new sheet's place in the order (call once, when it first renders). */
export const nextSheetSeq = () => ++seqNext;
/** Whether `me` is the newest open sheet (exported for the tests). */
export const isTopSheet = (me: { seq: number }) => open.has(me) && [...open].every((o) => o.seq <= me.seq);
/** Mark a sheet open until the returned cleanup runs. */
export function pushSheet(me: { seq: number }): () => void {
  open.add(me);
  return () => { open.delete(me); };
}
const escHandled = new WeakSet<Event>();

/** The sheet in its backdrop, portalled to the body, closing on Esc and on a backdrop mousedown. */
export function Sheet(props: SheetProps) {
  const { onClose, escFirst } = props;
  const [me] = useState(() => ({ seq: nextSheetSeq() }));
  useEffect(() => pushSheet(me), [me]);
  // Esc closes the sheet only when no side panel sits beside it (the app's own Esc closes that panel first), unless the
  // sheet is that panel's own (escFirst): then it closes the sheet and the app never sees the key
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      // one Esc closes one sheet: the top one (the sheet under it may already be top again when its listener runs)
      if (e.key !== "Escape" || escHandled.has(e) || !isTopSheet(me) || (store.state.panel && !escFirst) || (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT"))) return;
      escHandled.add(e);
      if (escFirst) e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose, escFirst, me]);
  return createPortal(
    <div className="sheet-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <SheetView {...props} />
    </div>,
    document.body,
  );
}

/** The sheet without its backdrop or portal (what the tests render). */
export function SheetView(p: SheetProps) {
  const [sideW, setSideW] = useSideWidth(p.sideKey ?? "");
  const share = p.sideShare ?? 36;
  const divider = <SheetDivider width={sideW} share={share / 100} label={p.dividerLabel ?? "Resize the sidebar"} onResize={p.sideKey ? setSideW : () => undefined} />;
  const hasSide = !!p.columns || p.side !== undefined;
  const cls = ["sheet-cols", hasSide ? "has-side" : "", hasSide && sideW ? "sized" : "", p.phone === "split" ? "phone-split" : ""].filter(Boolean).join(" ");
  const sideCls = p.sideClass ? `sheet-side ${p.sideClass}` : "sheet-side";
  const style: Record<string, string> = {};
  if (hasSide) style["--sheet-side-share"] = `${share}%`;
  if (hasSide && sideW) style["--sheet-side"] = `${sideW}px`;
  return (
    <div className={p.className ? `sheet ${p.className}` : "sheet"} role="dialog" aria-label={p.label} style={p.maxWidth ? { ["--sheet-max" as string]: `${p.maxWidth}px` } : undefined}>
      <header className="sheet-head">
        {p.icon ? <div className="panel-icon">{p.icon}</div> : null}
        <div className="who">
          <div className="who-title">{p.title}</div>
          {p.sub ? <div className="who-sub">{p.sub}</div> : null}
        </div>
        {p.actions}
        <button className="close" title="Close (Esc)" aria-label="Close" onClick={p.onClose}>×</button>
      </header>
      {p.status}
      <div className="sheet-body">
        {p.tabs}
        <div className={cls} style={hasSide ? style : undefined}>
          {p.columns ? p.columns(divider) : (
            <>
              <div className={p.mainClass ? `sheet-main ${p.mainClass}` : "sheet-main"} aria-label={p.mainLabel}>{p.children}</div>
              {hasSide ? <>{divider}{p.sideIsMain
                ? <main className={sideCls} aria-label={p.sideLabel} ref={p.sideRef} tabIndex={-1}>{p.side}</main>
                : <aside className={sideCls} aria-label={p.sideLabel} ref={p.sideRef}>{p.side}</aside>}</> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** A tab column: one button per tab, the current one marked; a row on a phone. */
export function SheetTabs({ tabs, tab, onTab, label }: { tabs: readonly string[]; tab: string; onTab: (t: string) => void; label: string }) {
  return (
    <nav className="sheet-tabs" role="tablist" aria-label={label}>
      {tabs.map((x) => (
        <button key={x} type="button" role="tab" aria-selected={x === tab} className={x === tab ? "sheet-tab on" : "sheet-tab"} onClick={() => onTab(x)}>{x}</button>
      ))}
    </nav>
  );
}
