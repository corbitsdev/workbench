// The one sidebar. Header: the brand mark, then a create dropdown + search.
// Body: Agents and Channels — nothing page-scoped ever renders here.
// Footer: the primary rail is Artifacts, Skills, Tools, Workflows, Agents.
// Below the rail: a single Settings row (icon + label) — Insights, the
// account menu (avatar, name, sign out), and everything else now live
// inside Settings itself, not as separate sidebar affordances.
// Always present; there is no collapse affordance and no second nav column.
// Approvals belong in the conversation, not as a standing band here.
//
// Inbox is gone (owner decision: tasks + approvals don't flow
// into workbenches). Mission Control is gone too — its pending-approvals
// and activity panels now live inside each workbench's own room.
//
// No bench switcher: a workbench IS an agent conversation now,
// one per account, so there is nothing to switch between in the common
// case. A multi-bench install still resolves and routes correctly (see
// `bench-context.tsx`) — it just has no dedicated chrome slot. The one
// escape hatch is the command palette's hidden "Switch workbench" action
// (`command-palette-actions.ts`), which only appears once memberships
// resolve to more than one workbench.

import {
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  SidebarPanel,
  SidebarPanelBody,
  SidebarPanelFooter,
} from "@corbits/react-ui";
import {
  FlowArrow,
  FolderOpen,
  Lightning,
  Plugs,
  Plus,
  Robot,
  SlidersHorizontal,
} from "@/lib/icons";
import { useState } from "react";

import { useBench } from "../bench-context";
import { NEW_CHAT_PATH } from "../chat-path";
import { CreateAgentPanel } from "../pages/create-agent-panel";
import { AGENTS_PATH_PREFIX } from "../path-ids";
import { matchesRoute, NEW_WORKBENCH_PATH, SETTINGS_PATH } from "../routes";
import { SidebarBrandMark } from "./brand-mark";
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
          dropdown (New Agent / New Chat / New Workbench) instead of
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
            <MenuItem onSelect={() => onNavigate(NEW_CHAT_PATH)}>New Chat</MenuItem>
            <MenuItem onSelect={() => onNavigate(NEW_WORKBENCH_PATH)}>New Workbench</MenuItem>
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

      <SidebarPanelFooter>
        {/* Footer order: Artifacts, Skills, Tools, Workflows, Agents, then
            one Settings row — Insights and the account menu (avatar, name,
            sign out) now live inside Settings itself, not as separate
            sidebar affordances. */}
        <button
          type="button"
          className="shell-sidebar-footer-row"
          data-active={matchesRoute("/artifacts", path) ? "true" : undefined}
          aria-current={matchesRoute("/artifacts", path) ? "page" : undefined}
          onClick={() => onNavigate("/artifacts")}
        >
          <FolderOpen />
          <span>Artifacts</span>
        </button>
        <button
          type="button"
          className="shell-sidebar-footer-row"
          data-active={matchesRoute("/skills", path) ? "true" : undefined}
          aria-current={matchesRoute("/skills", path) ? "page" : undefined}
          onClick={() => onNavigate("/skills")}
        >
          <Lightning />
          <span>Skills</span>
        </button>
        <button
          type="button"
          className="shell-sidebar-footer-row"
          data-active={matchesRoute("/tools", path) ? "true" : undefined}
          aria-current={matchesRoute("/tools", path) ? "page" : undefined}
          onClick={() => onNavigate("/tools")}
        >
          <Plugs />
          <span>Tools</span>
        </button>
        <button
          type="button"
          className="shell-sidebar-footer-row"
          data-active={matchesRoute("/workflows", path) ? "true" : undefined}
          aria-current={matchesRoute("/workflows", path) ? "page" : undefined}
          onClick={() => onNavigate("/workflows")}
        >
          <FlowArrow />
          <span>Workflows</span>
        </button>
        <button
          type="button"
          className="shell-sidebar-footer-row"
          data-active={matchesRoute("/agents", path) ? "true" : undefined}
          aria-current={matchesRoute("/agents", path) ? "page" : undefined}
          onClick={() => onNavigate("/agents")}
        >
          <Robot />
          <span>Agents</span>
        </button>

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
