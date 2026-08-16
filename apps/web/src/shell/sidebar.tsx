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
  SidebarPanel,
  SidebarPanelBody,
  SidebarPanelFooter,
} from "@corbits/react-ui";
import {
  Bell,
  ChevronRight,
  LogOut,
  MessageSquarePlus,
  Plug,
  Plus,
  SlidersHorizontal,
} from "lucide-react";
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
  const open = counts?.open ?? 0;
  // A footer row like Plugins: bell, "Inbox", and the open count when there
  // is one — the row IS the affordance, no popover in between.
  return (
    <button
      type="button"
      className="shell-sidebar-footer-row shell-sidebar-bell"
      data-active={active ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      aria-label="Notifications"
      onClick={() => onNavigate("/inbox")}
    >
      <Bell />
      <span>Inbox</span>
      {open > 0 ? (
        <span className="shell-sidebar-footer-count">{open}</span>
      ) : null}
    </button>
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
  const newWorkbench = () =>
    requestNewWorkbench({
      alreadyOnConversation: isChannelPath(path),
      navigateToConversations: () => onNavigate("/c"),
    });

  return (
    <SidebarPanel
      className="shell-sidebar"
      data-testid="shell-sidebar"
      aria-label="Workbenches"
    >
      {/* Owner's shape: logo with "+" on the first row, the search box
          (inside the list) below, then the plain "Workbenches" label. No
          header icon cluster — search is the box, notifications live in
          the footer. */}
      <div className="shell-sidebar-brand-row">
        <SidebarBrandMark />
        <Button
          variant="ghost"
          size="sm"
          aria-label="New workbench"
          title="New workbench"
          onClick={newWorkbench}
        >
          <Plus />
        </Button>
      </div>
      {/* The "Workbenches" label renders inside the list, below its search
          box (owner's order: logo · search · Workbenches · rows). */}

      <SidebarPanelBody>
        <WorkbenchList path={path} onNavigate={onNavigate} />
      </SidebarPanelBody>

      <div className="panel-activity-slot">
        <ActivityBand />
      </div>

      <SidebarPanelFooter>
        {/* Reference shape: one Plugins row, then the account row anchors
            everything else (Insights as usage, Settings, Log out) in its
            pop-up menu — a single footer, never two stacked rows. Inbox
            lives in the header beside search. */}
        <button
          type="button"
          className="shell-sidebar-footer-row"
          data-active={matchesRoute("/plugins", path) ? "true" : undefined}
          aria-current={matchesRoute("/plugins", path) ? "page" : undefined}
          onClick={() => onNavigate("/plugins")}
        >
          <Plug />
          <span>Plugins</span>
        </button>
        <InboxBell
          active={matchesRoute("/inbox", path)}
          onNavigate={onNavigate}
        />

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
