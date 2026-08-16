// The one sidebar. Header: create + search. Body: the workbench list —
// nothing page-scoped ever renders here. Footer: the needs-you activity
// band, the switcher, and the utility row (insights, inbox bell with its
// unread count, settings, account). Always present; there is no collapse
// affordance and no second nav column.

import {
  Avatar,
  Button,
  NotificationsBell,
  SidebarPanel,
  SidebarPanelBody,
  SidebarPanelFooter,
  SidebarPanelHeader,
} from "@corbits/react-ui";
import { ChartColumn, Plus, Search, Settings } from "lucide-react";

import { InboxCountsSchema, inboxCountsPath } from "../inbox-api";
import { useAPIQuery } from "../api";
import { useBench } from "../bench-context";
import { isChannelPath } from "../channel-path";
import { requestNewWorkbench } from "../command-palette-actions";
import { requestOpenCommandPalette } from "../command-palette-events";
import { matchesRoute, SETTINGS_PATH } from "../routes";
import type { SessionUser } from "../session";
import { ActivityBand } from "./activity-band";
import { BenchDock, initialsOf } from "./docks";
import { WorkbenchList } from "./workbench-list";

function FooterIconButton({
  label,
  active,
  onClick,
  children,
}: {
  readonly label: string;
  readonly active?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
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

export function Sidebar({
  path,
  user,
  onNavigate,
}: {
  readonly path: string;
  readonly user: SessionUser;
  readonly onNavigate: (to: string) => void;
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
      <SidebarPanelHeader title="Workbenches" action={headerAction} />

      <SidebarPanelBody>
        <WorkbenchList path={path} onNavigate={onNavigate} />
      </SidebarPanelBody>

      <div className="panel-activity-slot">
        <ActivityBand />
      </div>

      <SidebarPanelFooter>
        <BenchDock />
        <div className="shell-sidebar-utils">
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
          <button
            type="button"
            className="shell-sidebar-avatar-btn"
            aria-label={`${user.name} · Settings`}
            title={`${user.name} · Settings`}
            data-ctx-account=""
            onClick={() => onNavigate(SETTINGS_PATH)}
          >
            <Avatar
              initials={initialsOf(user.name)}
              label={user.name}
              size="sm"
              tone="neutral"
            />
          </button>
        </div>
      </SidebarPanelFooter>
    </SidebarPanel>
  );
}
