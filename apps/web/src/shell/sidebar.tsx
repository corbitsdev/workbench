// The one sidebar. Header: the brand mark, then create + search. Body: the
// workbench list — nothing page-scoped ever renders here. Footer: the
// needs-you activity band, the utility icon row (plugins, insights, inbox
// bell with its unread count, settings), and below it the account row —
// avatar + name, the whole row is the trigger for a menu that pops upward
// with weekly usage, settings, feedback, and log out. Always present;
// there is no collapse affordance and no second nav column.
//
// No bench switcher (CL-6089): a workbench IS an agent conversation now,
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
  NotificationsBell,
  SidebarPanel,
  SidebarPanelBody,
  SidebarPanelFooter,
  SidebarPanelHeader,
} from "@corbits/react-ui";
import {
  ChartColumn,
  ChevronRight,
  LogOut,
  MessageSquarePlus,
  Plug,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";

import {
  createInsightsWindow,
  formatUsd,
  tokensLabel,
} from "@corbits/insights/client";

import webPackage from "../../package.json";
import { InboxCountsSchema, inboxCountsPath } from "../inbox-api";
import { useAPIQuery } from "../api";
import { useBench } from "../bench-context";
import { isChannelPath } from "../channel-path";
import { requestNewWorkbench } from "../command-palette-actions";
import { requestOpenCommandPalette } from "../command-palette-events";
import { OverallUsageSchema, insightsUsagePath } from "../insights-api";
import { matchesRoute, SETTINGS_PATH } from "../routes";
import type { SessionUser } from "../session";
import { ActivityBand } from "./activity-band";
import { SidebarBrandMark } from "./brand-mark";
import { initialsOf } from "./docks";
import { WorkbenchList } from "./workbench-list";

/** The repo's own issue tracker — read off this package's manifest (set
 * from `git remote`) rather than a hardcoded org/repo guess. */
const FEEDBACK_URL = `${webPackage.repository.url}/issues`;

function FooterIconButton({
  label,
  active,
  onClick,
  children,
}: {
  readonly label: string;
  readonly active?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      title={label}
      aria-current={active === true ? "page" : undefined}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function InboxBell({
  active,
  onNavigate,
}: {
  readonly active: boolean;
  readonly onNavigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const countsQuery = useAPIQuery(
    selectedTenantId === null ? "" : inboxCountsPath(selectedTenantId),
    InboxCountsSchema,
  );
  const counts = countsQuery.kind === "ready" ? countsQuery.data : null;
  return (
    <div
      className="shell-sidebar-bell"
      data-active={active ? "true" : undefined}
    >
      <NotificationsBell count={counts?.open ?? 0}>
        <div className="shell-sidebar-bell-panel">
          <p className="panel-muted">
            {counts === null
              ? "Inbox"
              : counts.open === 0
                ? "Nothing needs you right now."
                : `${counts.open} open · ${counts.action} need action`}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate("/inbox")}
          >
            Open inbox
          </Button>
        </div>
      </NotificationsBell>
    </div>
  );
}

/**
 * One-line 7-day cost/token summary, read off the same cheap `/usage`
 * route the Insights landing tiles already use (CL-6132). No tenant, no
 * data yet, or a load error all render the same honest fallback — a plain
 * "Weekly usage" link with no number — never a fabricated figure.
 */
function WeeklyUsageMenuItem({
  onNavigate,
}: {
  readonly onNavigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const range = useMemo(() => createInsightsWindow(), []);
  const usageQuery = useAPIQuery(
    selectedTenantId === null ? "" : insightsUsagePath(selectedTenantId, range),
    OverallUsageSchema,
  );
  const usage = usageQuery.kind === "ready" ? usageQuery.data : null;
  const summary =
    usage === null
      ? null
      : `${formatUsd(usage.costUsd)} · ${tokensLabel(usage.tokens) ?? "0 tok"}`;

  return (
    <MenuItem
      onSelect={() => onNavigate("/insights")}
      className="shell-sidebar-account-menu-usage"
    >
      <span>Weekly usage</span>
      <span className="shell-sidebar-account-menu-usage-value">
        {summary}
        <ChevronRight />
      </span>
    </MenuItem>
  );
}

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
  const headerAction = (
    <div className="panel-page-tools">
      <Button
        variant="ghost"
        size="sm"
        aria-label="New workbench"
        title="New workbench"
        onClick={() =>
          requestNewWorkbench({
            alreadyOnConversation: isChannelPath(path),
            navigateToConversations: () => onNavigate("/c"),
          })
        }
      >
        <Plus />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Search"
        title="Search"
        onClick={() => requestOpenCommandPalette()}
      >
        <Search />
      </Button>
    </div>
  );

  return (
    <SidebarPanel
      className="shell-sidebar"
      data-testid="shell-sidebar"
      aria-label="Workbenches"
    >
      <SidebarBrandMark />
      <SidebarPanelHeader title="Workbenches" action={headerAction} />

      <SidebarPanelBody>
        <WorkbenchList path={path} onNavigate={onNavigate} />
      </SidebarPanelBody>

      <div className="panel-activity-slot">
        <ActivityBand />
      </div>

      <SidebarPanelFooter>
        <div className="shell-sidebar-utils">
          <FooterIconButton
            label="Plugins"
            active={matchesRoute("/plugins", path)}
            onClick={() => onNavigate("/plugins")}
          >
            <Plug />
          </FooterIconButton>
          <FooterIconButton
            label="Insights"
            active={matchesRoute("/insights", path)}
            onClick={() => onNavigate("/insights")}
          >
            <ChartColumn />
          </FooterIconButton>
          <InboxBell
            active={matchesRoute("/inbox", path)}
            onNavigate={onNavigate}
          />
          <FooterIconButton
            label="Settings"
            active={matchesRoute(SETTINGS_PATH, path)}
            onClick={() => onNavigate(SETTINGS_PATH)}
          >
            <Settings />
          </FooterIconButton>
        </div>

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
              />
              <span className="shell-sidebar-account-name">{user.name}</span>
            </button>
          </MenuTrigger>
          <MenuContent align="start" side="top">
            <WeeklyUsageMenuItem onNavigate={onNavigate} />
            <MenuItem onSelect={() => onNavigate(SETTINGS_PATH)}>
              <SlidersHorizontal /> Settings
            </MenuItem>
            <MenuItem asChild>
              <a href={FEEDBACK_URL} target="_blank" rel="noreferrer">
                <MessageSquarePlus /> Send Feedback
              </a>
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              onSelect={onSignOut}
              className="text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
            >
              <LogOut /> Log out
            </MenuItem>
          </MenuContent>
        </Menu>
      </SidebarPanelFooter>
    </SidebarPanel>
  );
}
