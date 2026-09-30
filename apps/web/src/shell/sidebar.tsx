// No bench switcher: a multi-bench install still resolves via the command
// palette's hidden "Switch workbench" action.

import { Button, SidebarPanel, SidebarPanelBody, SidebarPanelFooter } from "@corbits/react-ui";
import { MagnifyingGlass, Plus, SlidersHorizontal } from "@/lib/icons";

import { openCommandPalette } from "../command-palette-open-store";
import { matchesRoute, NEW_WORKBENCH_PATH, SETTINGS_PATH } from "../routes";
import { WorkbenchList } from "./workbench-list";

export function Sidebar({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  return (
    <SidebarPanel className="shell-sidebar" data-testid="shell-sidebar" aria-label="Workbenches">
      <div className="shell-sidebar-brand-row">
        <span className="shell-sidebar-wordmark">Workbench</span>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Search"
          title="Search"
          onClick={openCommandPalette}
        >
          <MagnifyingGlass />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="New workbench"
          title="New workbench"
          data-tour="new-workbench-button"
          onClick={() => onNavigate(NEW_WORKBENCH_PATH)}
        >
          <Plus />
        </Button>
      </div>

      <SidebarPanelBody data-tour="sidebar-list">
        <WorkbenchList path={path} onNavigate={onNavigate} />
      </SidebarPanelBody>

      <SidebarPanelFooter>
        <button
          type="button"
          className="shell-sidebar-footer-row"
          data-active={matchesRoute(SETTINGS_PATH, path) ? "true" : undefined}
          aria-current={matchesRoute(SETTINGS_PATH, path) ? "page" : undefined}
          data-tour="settings-button"
          onClick={() => onNavigate(SETTINGS_PATH)}
        >
          <SlidersHorizontal />
          <span>Settings</span>
        </button>
      </SidebarPanelFooter>
    </SidebarPanel>
  );
}
