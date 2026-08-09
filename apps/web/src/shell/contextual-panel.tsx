// Column 2: route-aware contextual panel with three bands.
//
// 1. Page band — title, settings entry, quick actions, canvas toggle.
// 2. Global pins — user-curated, same on every page.
// 3. Page-specific — contribution content for the current route.
//
// Live activity lives here (left), never in the right canvas. Clicking a
// list item navigates to the full surface for that entity.

import { Button, EmptyState, SidebarItemRow } from "@corbits/react-ui";
import { Pin as PinIcon, Settings } from "lucide-react";
import { useState } from "react";

import { CanvasToggle } from "./canvas-column";
import { NotificationsBand } from "./notifications-band";
import { resolvePanelContribution } from "./panel-contribution";
import { ensurePanelContributions } from "./panel-contributions";
import { loadPins, type Pin } from "./pins";

ensurePanelContributions();

export function ContextualPanel({
  path,
  onNavigate,
  canvasOpen,
  onToggleCanvas,
  canvasAllowed,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
  readonly canvasOpen: boolean;
  readonly onToggleCanvas: () => void;
  readonly canvasAllowed: boolean;
}) {
  const contribution = resolvePanelContribution(path);
  const pageBand = contribution?.pageBand({ path, onNavigate }) ?? {
    title: "Workbench",
    subtitle: "Navigate from the rail",
  };
  const pageSpecific =
    contribution?.pageSpecific?.({ path, onNavigate }) ?? null;

  const [pins] = useState<readonly Pin[]>(() => loadPins());

  return (
    <aside
      className="shell-contextual-panel"
      data-testid="shell-contextual-panel"
      aria-label="Contextual panel"
    >
      <section className="panel-band panel-band-page" aria-label="Page">
        <div className="panel-page-header">
          <div className="panel-page-identity">
            <h2 className="panel-page-title">{pageBand.title}</h2>
            {pageBand.subtitle !== undefined ? (
              <p className="panel-page-subtitle">{pageBand.subtitle}</p>
            ) : null}
          </div>
          <div className="panel-page-tools">
            {pageBand.settingsPath !== undefined ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Page settings"
                title="Page settings"
                onClick={() => {
                  const settingsPath = pageBand.settingsPath;
                  if (settingsPath !== undefined) onNavigate(settingsPath);
                }}
              >
                <Settings />
              </Button>
            ) : null}
            {canvasAllowed ? (
              <CanvasToggle open={canvasOpen} onToggle={onToggleCanvas} />
            ) : null}
          </div>
        </div>
        {pageBand.actions !== undefined && pageBand.actions.length > 0 ? (
          <div className="panel-page-actions">
            {pageBand.actions.map((action) => (
              <Button
                key={action.id}
                variant="outline"
                size="sm"
                onClick={action.onSelect}
              >
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}
        {pageBand.stats !== undefined ? (
          <div className="panel-page-stats">{pageBand.stats}</div>
        ) : null}
      </section>

      <section className="panel-band panel-band-pins" aria-label="Pinned">
        <h3 className="panel-band-heading">Pinned</h3>
        {pins.length === 0 ? (
          <p className="panel-muted">
            Pin channels, agents, or routines to keep them here on every page.
          </p>
        ) : (
          <div className="panel-stack">
            {pins.map((pin) => (
              <SidebarItemRow
                key={`${pin.kind}:${pin.id}`}
                name={pin.label}
                meta={pin.kind}
                onSelect={() => onNavigate(pin.href)}
              />
            ))}
          </div>
        )}
      </section>

      <NotificationsBand />

      <section
        className="panel-band panel-band-page-specific"
        aria-label={`${pageBand.title} details`}
      >
        <h3 className="panel-band-heading">{pageBand.title}</h3>
        {pageSpecific ?? (
          <EmptyState
            title="Nothing here yet"
            description="Page-specific activity will show in this band."
          />
        )}
      </section>
    </aside>
  );
}

// PinIcon kept for future pin-toggle affordances in rows.
void PinIcon;
