/**
 * The Bank as a centered sheet over the map (gr_567tikzitl step 1, kr_9xozv5d8gh; 1:1 mt_qdt8elaktu), on the shared Sheet
 * (Sheet.tsx, gr_4csjpgh346) like the goal editor: the tabs in a column on the left, the current tab's tables in the centre
 * (`.sheet-main`) and its explanations, Terms and selected row in the sidebar (`.sheet-side.bank-about`); BankView
 * (BankPanel.tsx) lays out both columns.
 * Opened by every PanelRef of kind "bank" (the Bank's room on the map, the HUD's "$", `#/bank`, the old `#/finance`, a
 * meeting's attached page); it stays open while a link from it fills the side panel (a grant), and × , Esc (with no side
 * panel open) or a click on the backdrop closes it.
 */
import { useState, type ComponentProps, type ReactNode } from "react";
import { BANK_TABS } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { Sheet, SheetTabs, SheetView, type SheetProps } from "./Sheet";
import { Glyph } from "./PanelShell";
import { BankView } from "./BankPanel";
import { useFinance } from "./BankFinance";
import { ErrorLine, Loading } from "./ui";
import { BANK_SIDE_KEY } from "./panelResize";

/** Refetch the summary the sign and these sections read. */
const reload = () => { api().bank().then((bank) => store.set({ bank }), () => undefined); };

/** The tab a "bank" PanelRef asks for, else the first. */
export const bankSheetTab = (tab?: string) => (tab && (BANK_TABS as readonly string[]).includes(tab) ? tab : BANK_TABS[0]);

export function BankSheet({ tab, onClose }: { tab?: string; onClose: () => void }) {
  const bank = useTown((s) => s.bank);
  const fin = useFinance();
  const [rev, setRev] = useState(0);
  const [t, setT] = useState(() => bankSheetTab(tab));
  const changed = () => { reload(); setRev((r) => r + 1); };
  return (
    <Sheet {...bankSheetProps({ tab: t, onTab: setT, onClose, icon: <Glyph kind="bank" />,
      view: { bank, fin: fin.data, rev, onChange: changed, onReload: reload },
      status: <>{fin.loading && !fin.data ? <Loading /> : null}<ErrorLine error={fin.error} /></> })} />
  );
}

type BankSheetArgs = {
  tab: string; onTab: (t: string) => void; onClose: () => void;
  view: Omit<ComponentProps<typeof BankView>, "tab" | "head" | "divider" | "selected">; status?: ReactNode; icon?: ReactNode;
};

/** The Bank on the shared Sheet: the tabs on the left, BankView lays out the centre (`.sheet-main`) and the sidebar. */
function bankSheetProps({ tab, onTab, onClose, view, status, icon }: BankSheetArgs): SheetProps {
  return {
    label: "The Bank", icon, onClose, title: "The Bank",
    sub: <>The town&apos;s tokens: what came in, where they went and what is left; hosting in dollars</>,
    tabs: <SheetTabs tabs={BANK_TABS} tab={tab} onTab={onTab} label="Bank tabs" />,
    columns: (divider) => <BankView key={tab} tab={tab} {...view} head={status} divider={divider} />,
    sideKey: BANK_SIDE_KEY, sideShare: 36, dividerLabel: "Resize the Bank's sidebar",
  };
}

/** The sheet without its backdrop or portal (what the tests render). */
export function BankSheetView(p: BankSheetArgs) {
  return <SheetView {...bankSheetProps(p)} />;
}
