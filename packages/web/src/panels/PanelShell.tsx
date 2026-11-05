import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { store } from "../state";
import { Tabs } from "./ui";
import { iconUrl, type IconKind } from "../map/sprites";
import { Sheet, SheetTabs } from "./Sheet";

/**
 * Set by the link sheet (LinkSheet.tsx): a panel rendered inside it (a grant, an agent) draws its frame as a centred Sheet
 * instead of the side panel's header, and its × closes the sheet, not the side panel under it.
 */
export const InSheet = createContext<{ onClose: () => void; label: string } | null>(null);

/** Right-side panel frame: header, optional tabs, scrolling body. Inside InSheet: the same parts as a centred Sheet. */
export function PanelShell({ icon, title, subtitle, tabs, initialTab, children, actions }: {
  icon?: ReactNode; title: ReactNode; subtitle?: ReactNode; tabs?: string[]; initialTab?: string; actions?: ReactNode;
  children: ReactNode | ((tab: string) => ReactNode);
}) {
  const sheet = useContext(InSheet);
  const [tab, setTab] = useState(initialTab ?? tabs?.[0] ?? "");
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);
  const body = typeof children === "function" ? children(tab) : children;
  if (sheet) {
    return (
      <Sheet label={typeof title === "string" ? title : sheet.label} title={title} sub={subtitle} icon={icon} actions={actions} onClose={sheet.onClose} escFirst maxWidth={980} className="link-sheet"
        tabs={tabs && tabs.length > 1 ? <SheetTabs tabs={tabs} tab={tab} onTab={setTab} label={`${sheet.label}: sections`} /> : undefined}>
        <div className="link-sheet-body" key={tab}>{body}</div>
      </Sheet>
    );
  }
  return (
    <>
      <header className="panel-head">
        {icon ? <div className="panel-icon">{icon}</div> : null}
        <div className="who">
          <div className="who-title">{title}</div>
          {subtitle ? <div className="who-sub">{subtitle}</div> : null}
        </div>
        {actions}
        <button className="close" title="Close (Esc)" aria-label="Close" onClick={() => store.open(null)}>×</button>
      </header>
      {tabs && tabs.length > 1 ? <Tabs tabs={tabs.map((t) => ({ id: t, label: t }))} active={tab} onChange={setTab} /> : null}
      <div className="panel-body" key={tab}>{body}</div>
    </>
  );
}

/** Tile-art icons for place panels, so headers match the map. */
export function Glyph({ kind }: { kind: IconKind }) {
  return <img className="glyph" src={iconUrl(kind)} alt="" aria-hidden />;
}
