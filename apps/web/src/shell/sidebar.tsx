// The one sidebar. Header: the brand mark, then create + search. Body: the
// workbench list — nothing page-scoped ever renders here. Footer: the
// utility icon row (Files, Skills, Agents, Plugins, Insights, Evals —
// CL-6353/CL-6354/CL-6355 moved the first three out of Settings and onto
// this row; CL-6465 added Evals alongside Insights), and below it the
// account row —
// avatar + name, the whole row is the trigger for a menu that pops upward
// with weekly usage, settings, feedback, and log out. Always present;
// there is no collapse affordance and no second nav column. Approvals
// belong in the conversation, not as a standing band here.
//
// Inbox is gone (CL-6151, owner decision: tasks + approvals don't flow
// into workbenches) — Insights took its footer slot instead.
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
  CaretRight,
  ChartBar,
  ChatCircleDots,
  FolderOpen,
  Lightning,
  ListBullets,
  Plus,
  PuzzlePiece,
  Robot,
  SignOut,
  Repeat,
  SlidersHorizontal,
  SquaresFour,
} from "@corbits/icons";
import { useMemo } from "react";

import {
  createInsightsWindow,
  formatUsd,
  tokensLabel,
} from "@corbits/insights/client";

import webPackage from "../../package.json";
import { useAPIQuery } from "../api";
import { useBench } from "../bench-context";
import { OverallUsageSchema, insightsUsagePath } from "../insights-api";
import {
  matchesRoute,
  MISSION_CONTROL_PATH,
  NEW_WORKBENCH_PATH,
  SETTINGS_PATH,
} from "../routes";
import type { SessionUser } from "../session";
import { SidebarBrandMark } from "./brand-mark";
import { initialsOf } from "./docks";
import { WorkbenchList } from "./workbench-list";

/** The repo's own issue tracker — read off this package's manifest (set
 * from `git remote`) rather than a hardcoded org/repo guess. */
const FEEDBACK_URL = `${webPackage.repository.url}/issues`;

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
        <CaretRight />
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
  return (
    <SidebarPanel
      className="shell-sidebar"
      data-testid="shell-sidebar"
      aria-label="Workbenches"
    >
      {/* Owner's shape: logo with "+" on the first row, the search box
          (inside the list) below, then the plain "Workbenches" label. No
          header icon cluster — search is the box. */}
      <div className="shell-sidebar-brand-row">
        <SidebarBrandMark />
        <Button
          variant="ghost"
          size="sm"
          aria-label="New workbench"
          title="New workbench"
          onClick={() => onNavigate(NEW_WORKBENCH_PATH)}
        >
          <Plus />
        </Button>
      </div>
      {/* The "Workbenches" label renders inside the list, below its search
          box (owner's order: logo · search · Workbenches · rows). */}

      <SidebarPanelBody>
        <WorkbenchList path={path} onNavigate={onNavigate} />
      </SidebarPanelBody>

      {/* Mission Control is pinned above the footer rail as its own row
          (DESIGN.md's Shell & Navigation) — not a 7th button inside the
          rail below, which stays Routines/Files/Skills/Agents/Plugins/
          Insights exactly as it was. */}
      <div className="shell-sidebar-mission-control">
        <button
          type="button"
          className="shell-sidebar-mission-control-row"
          data-active={
            matchesRoute(MISSION_CONTROL_PATH, path) ? "true" : undefined
          }
          aria-current={
            matchesRoute(MISSION_CONTROL_PATH, path) ? "page" : undefined
          }
          onClick={() => onNavigate(MISSION_CONTROL_PATH)}
        >
          <SquaresFour />
          <span>Mission Control</span>
        </button>
      </div>

      <SidebarPanelFooter>
        {/* Footer order: Routines, Files, Skills, Agents, Plugins, Insights,
            Evals, then the account row anchors everything else (weekly
            usage, Settings, Log out) in its pop-up menu — a single footer,
            never two stacked rows. Routines (CL-6362) is global-only here —
            no per-workbench routines chrome remains. */}
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
        <button
          type="button"
          className="shell-sidebar-footer-row"
          data-active={matchesRoute("/plugins", path) ? "true" : undefined}
          aria-current={matchesRoute("/plugins", path) ? "page" : undefined}
          onClick={() => onNavigate("/plugins")}
        >
          <PuzzlePiece />
          <span>Plugins</span>
        </button>
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
        <button
          type="button"
          className="shell-sidebar-footer-row"
          data-active={matchesRoute("/evals", path) ? "true" : undefined}
          aria-current={matchesRoute("/evals", path) ? "page" : undefined}
          onClick={() => onNavigate("/evals")}
        >
          <ListBullets />
          <span>Evals</span>
        </button>

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
      </SidebarPanelFooter>
    </SidebarPanel>
  );
}
