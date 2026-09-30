// No bench switcher: a multi-bench install still resolves via the command
// palette's hidden "Switch workbench" action.

import {
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  SidebarPanel,
  SidebarPanelBody,
} from "@corbits/react-ui";
import { Plus } from "@/lib/icons";
import { useState } from "react";

import { useBench } from "../bench-context";
import { CreateAgentPanel } from "../pages/create-agent-panel";
import { AGENTS_PATH_PREFIX } from "../path-ids";
import { NEW_WORKBENCH_PATH } from "../routes";
import { SidebarBrandMark } from "./brand-mark";
import { SidebarFooter } from "./sidebar-footer";
import { WorkbenchList } from "./workbench-list";

export function Sidebar({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const [createAgentOpen, setCreateAgentOpen] = useState(false);

  return (
    <SidebarPanel
      className="shell-sidebar"
      data-testid="shell-sidebar"
      aria-label="Agents and Channels"
    >
      {/* Owner's shape: logo with "+" on the first row, the search box
          (inside the list) below, then Agents and Channels. No
          header icon cluster — search is the box. The "+" now opens a
          dropdown (New Agent / New Workbench) instead of
          jumping straight to New chat. */}
      <div className="shell-sidebar-brand-row">
        <SidebarBrandMark />
        <Menu>
          <MenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Create new"
              title="Create new"
              data-tour="new-workbench-button"
            >
              <Plus />
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem
              disabled={selectedTenantId === null}
              onSelect={() => setCreateAgentOpen(true)}
            >
              New Agent
            </MenuItem>
            <MenuItem onSelect={() => onNavigate(NEW_WORKBENCH_PATH)}>
              New Workbench
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {/* Agents and Channels labels render inside the list, below its
          search box (owner's order: logo · search · sections · rows). */}

      <SidebarPanelBody data-tour="sidebar-list">
        <WorkbenchList path={path} onNavigate={onNavigate} />
      </SidebarPanelBody>

      {selectedTenantId === null ? null : (
        <CreateAgentPanel
          open={createAgentOpen}
          onOpenChange={setCreateAgentOpen}
          tenantId={selectedTenantId}
          onCreated={() => onNavigate(AGENTS_PATH_PREFIX)}
        />
      )}

      <SidebarFooter path={path} onNavigate={onNavigate} />
    </SidebarPanel>
  );
}
