import { useEffect, useState, type ReactNode } from "react";
import { store } from "../state";
import { Tabs } from "./ui";
import { iconUrl, type IconKind } from "../map/sprites";

/** Right-side panel frame: header, optional tabs, scrolling body. */
export function PanelShell({ icon, title, subtitle, tabs, initialTab, children, actions }: {
  icon?: ReactNode; title: ReactNode; subtitle?: ReactNode; tabs?: string[]; initialTab?: string; actions?: ReactNode;
  children: ReactNode | ((tab: string) => ReactNode);
}) {
  const [tab, setTab] = useState(initialTab ?? tabs?.[0] ?? "");
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);
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
      <div className="panel-body" key={tab}>{typeof children === "function" ? children(tab) : children}</div>
    </>
  );
}

/** Tile-art icons for place panels, so headers match the map. */
export function Glyph({ kind }: { kind: IconKind }) {
  return <img className="glyph" src={iconUrl(kind)} alt="" aria-hidden />;
}
