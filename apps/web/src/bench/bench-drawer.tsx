import { Button } from "@corbits/react-ui";
import { X } from "@/lib/icons";
import "./drawer.css";
import { useEffect, useRef, useState, type ReactNode } from "react";

export const DRAWER_TABS = [
  "Information",
  "Artifacts",
  "Tools",
  "Grants",
  "Insights",
  "Members",
  "Workflows",
] as const;

export type DrawerTab = (typeof DRAWER_TABS)[number];

/** The floating card in the grid column that pushes the thread left. Each
 * tab's body arrives as a prop keyed by tab name; a tab without one shows a
 * short empty state until its own ticket lands. */
export function BenchDrawer({
  open,
  title,
  subtitle,
  onClose,
  tabs,
}: {
  readonly open: boolean;
  readonly title: string;
  /** The bench description; nothing renders without one. */
  readonly subtitle?: string | undefined;
  readonly onClose: () => void;
  readonly tabs: Partial<Record<DrawerTab, ReactNode>>;
}) {
  const [tab, setTab] = useState<DrawerTab>("Information");
  const ref = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  // Never scrollIntoView: it scrolls the clipped work sheet and jerks the view.
  useEffect(() => {
    const strip = stripRef.current;
    const active = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (strip === null || strip === undefined || active === null || active === undefined) return;
    if (
      active.offsetLeft < strip.scrollLeft ||
      active.offsetLeft + active.offsetWidth > strip.scrollLeft + strip.clientWidth
    ) {
      strip.scrollLeft = active.offsetLeft - 16;
    }
  }, [tab, open]);

  useEffect(() => {
    if (!open) return;
    // preventScroll: focusing must never shift the thread's scroll position.
    ref.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const body = tabs[tab];
  return (
    <div className="drawer-cell">
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <div
        id="bench-drawer"
        ref={ref}
        className="drawer"
        role="dialog"
        aria-label={`${title} details`}
        aria-hidden={!open}
        inert={!open}
        tabIndex={-1}
      >
        <div className="drawer-head">
          <div>
            <h2>{title}</h2>
            {subtitle === undefined || subtitle === "" ? null : <p>{subtitle}</p>}
          </div>
          <Button variant="ghost" size="sm" aria-label="Close drawer" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
        <div className="drawer-tabs" role="tablist" ref={stripRef}>
          {DRAWER_TABS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={name === tab}
              className={name === tab ? "active" : undefined}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="drawer-body" role="tabpanel">
          {body ?? (
            <p className="workbench-info-empty-note">{tab} is coming to this drawer soon.</p>
          )}
        </div>
      </div>
    </div>
  );
}
