// Column 2 is route context, not a second app nav. Page contributions provide
// its title, compact actions, and lists while the shell owns shared chrome.

import {
  Button,
  SidebarItemRow,
  SidebarPanel,
  SidebarPanelBody,
  SidebarPanelFooter,
  SidebarPanelHeader,
  SidebarPanelPins,
} from "@corbits/react-ui";
import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";

import { ActivityBand } from "./activity-band";
import { BenchDock } from "./docks";
import { resolvePanelContribution } from "./panel-contribution";
import { ensurePanelContributions } from "./panel-contributions";
import { loadPins, type Pin } from "./pins";

ensurePanelContributions();

export function ContextualPanel({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  const contribution = resolvePanelContribution(path);
  const renderCtx = { path, onNavigate };
  const pageBand = contribution?.pageBand(renderCtx) ?? {
    title: "Workbench",
    subtitle: "Navigate from the rail",
  };
  const pageSpecific = contribution?.pageSpecific?.(renderCtx) ?? null;
  const [pins] = useState<readonly Pin[]>(() => loadPins());

  const headerAction = (
    <div className="panel-page-tools">
      {pageBand.headerActions?.map((action) => (
        <Button
          key={action.id}
          variant="ghost"
          size="sm"
          aria-label={action.label}
          title={action.label}
          onClick={action.onSelect}
        >
          {action.icon ?? action.label}
        </Button>
      ))}
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
          <SlidersHorizontal />
        </Button>
      ) : null}
    </div>
  );

  return (
    <SidebarPanel
      className="shell-contextual-panel"
      data-testid="shell-contextual-panel"
      aria-label="Contextual panel"
    >
      <SidebarPanelHeader title={pageBand.title} action={headerAction} />

      {pageBand.subtitle !== undefined ? (
        <p className="panel-page-subtitle panel-band-inset">
          {pageBand.subtitle}
        </p>
      ) : null}

      {pageBand.actions !== undefined && pageBand.actions.length > 0 ? (
        <div className="panel-page-actions panel-band-inset">
          {pageBand.actions.map((action) => (
            <Button
              key={action.id}
              variant="outline"
              size="sm"
              onClick={action.onSelect}
            >
              {action.icon}
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
      {pageBand.stats !== undefined ? (
        <div className="panel-page-stats panel-band-inset">
          {pageBand.stats}
        </div>
      ) : null}

      {pins.length > 0 ? (
        <SidebarPanelPins aria-label="Pinned">
          <h3 className="panel-band-heading">Pinned</h3>
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
        </SidebarPanelPins>
      ) : null}

      <SidebarPanelBody>
        {pageSpecific !== null ? (
          <section
            className="panel-band panel-band-page-specific"
            aria-label="Page details"
          >
            {pageSpecific}
          </section>
        ) : null}
        <ActivityBand />
      </SidebarPanelBody>

      <SidebarPanelFooter>
        <BenchDock />
      </SidebarPanelFooter>
    </SidebarPanel>
  );
}
