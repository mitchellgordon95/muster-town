/**
 * The Bank as a centered sheet over the map (gr_567tikzitl step 1, kr_9xozv5d8gh; 1:1 mt_qdt8elaktu), the same shell as the
 * goal editor (GoalTreePanel): the tabs in a column on the left, the current tab's tables in the centre (`.bank-main`) and
 * its explanations, Terms and selected row in a right sidebar (`.bank-side`); BankView (BankPanel.tsx) lays out both columns.
 * Opened by every PanelRef of kind "bank" (the Bank's room on the map, the HUD's "$", `#/bank`, the old `#/finance`, a
 * meeting's attached page); it stays open while a link from it fills the side panel (a grant), and × , Esc (with no side
 * panel open) or a click on the backdrop closes it.
 */
import { useEffect, useState, type ComponentProps, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BANK_TABS } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { Glyph } from "./PanelShell";
import { BankView } from "./BankPanel";
import { useFinance } from "./BankFinance";
import { ErrorLine, Loading } from "./ui";
import { RESIZE_HINT, geDetailWidth } from "./panelResize";

/** Refetch the summary the sign and these sections read. */
const reload = () => { api().bank().then((bank) => store.set({ bank }), () => undefined); };

/** The tab a "bank" PanelRef asks for, else the first. */
export const bankSheetTab = (tab?: string) => (tab && (BANK_TABS as readonly string[]).includes(tab) ? tab : BANK_TABS[0]);

export function BankSheet({ tab, onClose }: { tab?: string; onClose: () => void }) {
  const bank = useTown((s) => s.bank);
  const fin = useFinance();
  const [rev, setRev] = useState(0);
  const [t, setT] = useState(() => bankSheetTab(tab));
  const [sideW, setSideW] = useBankSideWidth();
  const changed = () => { reload(); setRev((r) => r + 1); };
  // Esc closes the sheet only when no side panel sits beside it (the app's own Esc closes the Bank's panel ref first)
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (e.key !== "Escape" || store.state.panel || (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT"))) return;
      onClose();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  return createPortal(
    <div className="bank-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <BankSheetView icon={<Glyph kind="bank" />} tab={t} onTab={setT} onClose={onClose} sideW={sideW} onSideW={setSideW}
        view={{ bank, fin: fin.data, rev, onChange: changed, onReload: reload }}
        status={<>{fin.loading && !fin.data ? <Loading /> : null}<ErrorLine error={fin.error} /></>} />
    </div>,
    document.body,
  );
}

type SheetProps = {
  tab: string; onTab: (t: string) => void; onClose: () => void; sideW: number | null; onSideW: (w: number | null) => void;
  view: Omit<ComponentProps<typeof BankView>, "tab" | "head" | "divider" | "selected">; status?: ReactNode; icon?: ReactNode;
};

/** The sheet without its backdrop or portal (what the tests render): head, tab column, centre, divider, sidebar. */
export function BankSheetView({ tab, onTab, onClose, sideW, onSideW, view, status, icon }: SheetProps) {
  return (
    <div className="bank-sheet" role="dialog" aria-label="The Bank">
      <header className="bank-head">
        {icon ? <div className="panel-icon">{icon}</div> : null}
        <div className="who">
          <div className="who-title">The Bank</div>
          <div className="who-sub">The town&apos;s tokens: what came in, where they went and what is left; hosting in dollars</div>
        </div>
        <button className="close" title="Close (Esc)" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <div className="bank-body">
        <BankTabs tab={tab} onTab={onTab} />
        <div className={sideW ? "bank-cols sized" : "bank-cols"} style={sideW ? { ["--bank-side" as string]: `${sideW}px` } : undefined}>
          <BankView key={tab} tab={tab} {...view} head={status} divider={<BankDivider width={sideW} onResize={onSideW} />} />
        </div>
      </div>
    </div>
  );
}

/** The tab list: one button per BANK_TABS entry, a column on the left (a row on a phone). */
function BankTabs({ tab, onTab }: { tab: string; onTab: (t: string) => void }) {
  return (
    <nav className="bank-tabs" role="tablist" aria-label="Bank tabs">
      {BANK_TABS.map((x) => (
        <button key={x} type="button" role="tab" aria-selected={x === tab} className={x === tab ? "bank-tab on" : "bank-tab"} onClick={() => onTab(x)}>{x}</button>
      ))}
    </nav>
  );
}

/** The sidebar's width, saved apart from the goal editor's (geDetailWidth's clamps: sidebar ≥ 320 px, centre ≥ 360 px). */
const BANK_SIDE_KEY = "musterTown.bank.sideWidth";
function useBankSideWidth(): [number | null, (w: number | null) => void] {
  const [w, setW] = useState<number | null>(() => { try { const v = Number(localStorage.getItem(BANK_SIDE_KEY)); return v > 0 ? v : null; } catch { return null; } });
  return [w, (v) => { try { if (v === null) localStorage.removeItem(BANK_SIDE_KEY); else localStorage.setItem(BANK_SIDE_KEY, String(Math.round(v))); } catch { /* private window */ } setW(v); }];
}

/** The drag handle between the centre and the sidebar (a copy of the goal editor's GeDivider with its own saved width). */
function BankDivider({ width, onResize }: { width: number | null; onResize: (w: number | null) => void }) {
  const [dragging, setDragging] = useState(false);
  const body = (el: HTMLElement) => el.parentElement?.getBoundingClientRect() ?? { left: 0, width: window.innerWidth };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(true);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const r = body(e.currentTarget);
    onResize(geDetailWidth(e.clientX, r.left, r.width));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => { e.currentTarget.releasePointerCapture?.(e.pointerId); setDragging(false); };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const r = body(e.currentTarget);
    const now = width ?? Math.round(r.width * 0.36);
    if (e.key === "ArrowLeft") onResize(geDetailWidth(r.left + r.width - now - 40, r.left, r.width));
    else if (e.key === "ArrowRight") onResize(geDetailWidth(r.left + r.width - now + 40, r.left, r.width));
    else if (e.key === "Home") onResize(null);
    else return;
    e.preventDefault();
  };
  return (
    <div className={dragging ? "bank-divider dragging" : "bank-divider"} role="separator" aria-orientation="vertical"
      aria-label="Resize the Bank's sidebar" aria-valuenow={width ?? undefined} tabIndex={0} title={RESIZE_HINT}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onDoubleClick={() => onResize(null)} onKeyDown={key} />
  );
}
