// The one sidebar. Header: the brand mark, then create + search. Body:
// Agents and Channels — nothing page-scoped ever renders here. Footer: the
// first-run rail is Routines, Files, Skills, Agents; Insights
// joins only when the existing run reads return real items (never a
// fabricated row, never a new analytics store). Below the rail:
// the account row — avatar + name, the whole row is the trigger for a menu
// that pops upward with settings, feedback, and log out.
// Always present; there is no collapse affordance and no second nav column.
// Approvals belong in the conversation, not as a standing band here.
//
// Inbox is gone (owner decision: tasks + approvals don't flow
// into workbenches).
//
// No bench switcher: a workbench IS an agent conversation now,
// one per account, so there is nothing to switch between in the common
// case. A multi-bench install still resolves and routes correctly (see
// `bench-context.tsx`) — it just has no dedicated chrome slot. The one
// escape hatch is the command palette's hidden "Switch workbench" action
// (`command-palette-actions.ts`), which only appears once memberships
// resolve to more than one workbench.

import {
  Avatar,
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  SidebarPanel,
  SidebarPanelBody,
  SidebarPanelFooter,
} from "@corbits/react-ui";
import {
  ChartBar,
  ChatCircleDots,
  FolderOpen,
  Lightning,
  Plus,
  Robot,
  SignOut,
  Repeat,
  SlidersHorizontal,
  SquaresFour,
} from "@/lib/icons";

import { CHAT_STRINGS, avatarClassForPrincipal } from "@/chat";

import webPackage from "../../package.json";
import { useAPIQuery } from "../api";
import { useBench } from "../bench-context";
import { TopLevelRunsSchema, insightsTopLevelRunsPath } from "../insights-api";
import { matchesRoute, MISSION_CONTROL_PATH, NEW_WORKBENCH_PATH, SETTINGS_PATH } from "../routes";
import type { SessionUser } from "../session";
import { SidebarBrandMark } from "./brand-mark";
import { initialsOf } from "./docks";
import { WorkbenchList } from "./workbench-list";

/** The repo's own issue tracker — read off this package's manifest (set
 * from `git remote`) rather than a hardcoded org/repo guess. */
const FEEDBACK_URL = `${webPackage.repository.url}/issues`;

export function Sidebar({
  path,
  user,
  onNavigate,
  onSignOut,
}: {
  readonly path: string;
  readonly user: SessionUser;
  readonly onNavigate: (to: string) => void;
  readonly onSignOut: () => void;
}) {
  const { selectedTenantId } = useBench();
  const runsQuery = useAPIQuery(
    selectedTenantId === null ? "" : insightsTopLevelRunsPath(selectedTenantId),
    TopLevelRunsSchema,
  );
  const showInsights = runsQuery.kind === "ready" && runsQuery.data.data.length > 0;

  return (
    <SidebarPanel
      className="shell-sidebar"
      data-testid="shell-sidebar"
      aria-label="Agents and Channels"
    >
      {/* Owner's shape: logo with "+" on the first row, the search box
          (inside the list) below, then Agents and Channels. No
          header icon cluster — search is the box. */}
      <div className="shell-sidebar-brand-row">
        <SidebarBrandMark />
        <Button
          variant="ghost"
          size="sm"
          aria-label={CHAT_STRINGS.newWorkbenchAction}
          title={CHAT_STRINGS.newWorkbenchAction}
          onClick={() => onNavigate(NEW_WORKBENCH_PATH)}
        >
          <Plus />
        </Button>
      </div>
      {/* Agents and Channels labels render inside the list, below its
          search box (owner's order: logo · search · sections · rows). */}

      <SidebarPanelBody>
        <WorkbenchList path={path} onNavigate={onNavigate} />
      </SidebarPanelBody>

      {/* Mission Control is pinned above the footer rail as its own row
          (DESIGN.md's Shell & Navigation) — not a button inside the
          first-run rail, which stays Routines/Files/Skills/Agents. */}
      <div className="shell-sidebar-mission-control">
        <button
          type="button"
          className="shell-sidebar-mission-control-row"
          data-active={matchesRoute(MISSION_CONTROL_PATH, path) ? "true" : undefined}
          aria-current={matchesRoute(MISSION_CONTROL_PATH, path) ? "page" : undefined}
          onClick={() => onNavigate(MISSION_CONTROL_PATH)}
        >
          <SquaresFour />
          <span>Mission Control</span>
        </button>
      </div>

      <SidebarPanelFooter>
        {/* Footer order: Routines, Files, Skills, Agents, then
            Insights only when that existing read proves real items, then
            the account row anchors everything else (settings, feedback,
            log out) in its pop-up menu — a single footer, never two
            stacked rows. */}
        <button
          type="button"
          className="shell-sidebar-footer-row"
          data-active={matchesRoute("/routines", path) ? "true" : undefined}
          aria-current={matchesRoute("/routines", path) ? "page" : undefined}
          onClick={() => onNavigate("/routines")}
        >
          <Repeat />
          <span>Routines</span>
        </button>
        <button
          type="button"
          className="shell-sidebar-footer-row"
          data-active={matchesRoute("/files", path) ? "true" : undefined}
          aria-current={matchesRoute("/files", path) ? "page" : undefined}
          onClick={() => onNavigate("/files")}
        >
          <FolderOpen />
          <span>Files</span>
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
          data-active={matchesRoute("/agents", path) ? "true" : undefined}
          aria-current={matchesRoute("/agents", path) ? "page" : undefined}
          onClick={() => onNavigate("/agents")}
        >
          <Robot />
          <span>Agents</span>
        </button>
        {showInsights ? (
          <button
            type="button"
            className="shell-sidebar-footer-row"
            data-active={matchesRoute("/insights", path) ? "true" : undefined}
            aria-current={matchesRoute("/insights", path) ? "page" : undefined}
            onClick={() => onNavigate("/insights")}
          >
            <ChartBar />
            <span>Insights</span>
          </button>
        ) : null}

        <div className="shell-sidebar-account-row">
          <Menu>
            <MenuTrigger asChild>
              <button
                type="button"
                className="shell-sidebar-account-btn"
                aria-label={`${user.name} · Account menu`}
                title={user.name}
                data-ctx-account=""
              >
                <Avatar
                  initials={initialsOf(user.name)}
                  label={user.name}
                  size="sm"
                  tone="neutral"
                  className={avatarClassForPrincipal(user.id)}
                />
                <span className="shell-sidebar-account-name">{user.name}</span>
              </button>
            </MenuTrigger>
            <MenuContent align="start" side="top">
              <MenuItem asChild>
                <a href={FEEDBACK_URL} target="_blank" rel="noreferrer">
                  <ChatCircleDots /> Send Feedback
                </a>
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                onSelect={onSignOut}
                className="text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
              >
                <SignOut /> Log out
              </MenuItem>
            </MenuContent>
          </Menu>
          <Button
            variant="ghost"
            size="icon"
            className="shell-sidebar-settings-btn"
            aria-label="Settings"
            title="Settings"
            data-active={matchesRoute(SETTINGS_PATH, path) ? "true" : undefined}
            onClick={() => onNavigate(SETTINGS_PATH)}
          >
            <SlidersHorizontal />
          </Button>
        </div>
      </SidebarPanelFooter>
    </SidebarPanel>
  );
}
