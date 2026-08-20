// The route table: one entry per screen, consumed by the command palette
// (label) and the route switch (render), so navigation and pages cannot
// drift apart. The sidebar itself lists workbenches (conversations), not
// routes — Files, Skills, Agents, Plugins, Insights, and Settings are
// reached from its footer, and everything here also stays reachable by
// deep link and the palette. Conversation deep links (`/w/:workbenchId`)
// stay routable; `/` is the Myra land hop (ensure + open her conversation)
// for a bench with a workbench already, or the guided first-workbench
// describe screen for a bench with none (CL-6104) — never a Home
// dashboard.
// Approvals has no page — the Activity band owns them. Agents (CL-6354)
// and Skills (CL-6355) are their own rail destinations again — they spent
// a stretch as Settings sections (CL-5990) and `/settings/agents[/:id]` /
// `/settings/skills[/:id]` stay routable only as redirects back here, so
// old links and bookmarks still land somewhere real. Library was renamed
// Files (CL-6353) at the same time it moved off `/library`, which
// redirects the same way. Inbox is gone too (CL-6151: tasks + approvals
// don't flow into workbenches); `/inbox` stays routable only as a
// redirect to `/`.

import {
  ChatCircle,
  ChartBar,
  FlowArrow,
  FolderOpen,
  Lightning,
  Robot,
  SlidersHorizontal,
  SquaresFour,
} from "@corbits/icons";
import { lazy, useEffect, type ReactElement, type ReactNode } from "react";

import { WORKBENCH_PATH_PREFIX, isWorkbenchPath } from "./workbench-path";
import {
  LegacyLibraryRedirect,
  LegacySettingsAgentsRedirect,
  LegacySettingsSkillsRedirect,
} from "./pages/legacy-settings-redirects";

// Each signed-in page is a dynamic import so Vite emits one chunk per
// screen. Static imports here pulled chat-ui, artifact-ui, settings-ui,
// plugins-ui, and insights into a single 1.2 MB SPA.

const HomeRoute = lazy(async () => ({
  default: (await import("./pages/home-page")).HomeRoute,
}));
const NewWorkbenchPickerRoute = lazy(async () => ({
  default: (await import("./pages/new-workbench-picker"))
    .NewWorkbenchPickerRoute,
}));
const ChatPage = lazy(async () => ({
  default: (await import("./pages/chat-page")).ChatPage,
}));
const RoutinesRoute = lazy(async () => ({
  default: (await import("./pages/routines-page")).RoutinesRoute,
}));
const LibraryRoute = lazy(async () => ({
  default: (await import("./pages/library-page")).LibraryRoute,
}));
const AgentsRoute = lazy(async () => ({
  default: (await import("./pages/agents-page")).AgentsRoute,
}));
const SkillsRoute = lazy(async () => ({
  default: (await import("./pages/skills-page")).SkillsRoute,
}));
const InsightsRoute = lazy(async () => ({
  default: (await import("./pages/insights-page")).InsightsRoute,
}));
const PluginsRoute = lazy(async () => ({
  default: (await import("./pages/plugins-page")).PluginsRoute,
}));
const SettingsRoute = lazy(async () => ({
  default: (await import("./pages/settings-page")).SettingsRoute,
}));

/** The signed-out screen (CL-6369) — a real route, not a conditional swap:
 * any unauthenticated request for another path bounces here with `?next=`
 * so a successful sign-in returns to where the visitor meant to go. Not
 * one of `APP_ROUTES`: like `ONBOARDING_PATH`, it renders above the shell
 * entirely (no sidebar, no chrome to be "current" in) and is reached only
 * through the signed-out branch of `App`'s session switch. */
export const LOGIN_PATH = "/login";

/** Landing point for a session the first-login hook just provisioned a
 * personal bench for. Not one of `APP_ROUTES`: it has no sidebar entry,
 * it is only ever reached by the first-login redirect. */
export const ONBOARDING_PATH = "/onboarding";

/** Settings path — sidebar footer + settings page. */
export const SETTINGS_PATH = "/settings";

/** The template picker (CL-6342) — every "+ New workbench" affordance
 * (sidebar, command palette) hops here first; picking a row is what
 * actually mints the workbench. Not in `NAV_ROUTES`: it has no sidebar
 * row of its own, only the "+" control and the palette reach it. */
export const NEW_WORKBENCH_PATH = "/new";

export type AppRoute = {
  readonly path: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly render: (
    path: string,
    navigate: (to: string) => void,
  ) => ReactElement;
  /** False only for the one screen with no `StageTopBar` of its own — Myra
   * land (`/`) is a bare ensure+redirect hop (see `pages/home-page.tsx`)
   * with nothing in the stage to title itself while it resolves. `AppShell`
   * covers that gap generically (`shell/app-shell.tsx`) rather than home-page
   * inventing chrome for a screen that's never meant to linger. Every other
   * route titles its own stage. */
  readonly hasStageTopBar?: boolean;
};

/**
 * Matches nested product paths (`/routines/:id`, `/insights/...`) plus
 * conversation deep links (which also match when Myra land `/` is active).
 * Other routes are exact path matches.
 */
export function matchesRoute(routePath: string, path: string): boolean {
  if (routePath === WORKBENCH_PATH_PREFIX) {
    return isWorkbenchPath(path) || path === "/";
  }
  if (
    routePath === "/routines" ||
    routePath === "/library" ||
    routePath === "/files" ||
    routePath === "/insights" ||
    routePath === "/agents" ||
    routePath === "/skills" ||
    routePath === "/settings/agents" ||
    routePath === "/settings/skills" ||
    routePath === SETTINGS_PATH
  ) {
    return path === routePath || path.startsWith(`${routePath}/`);
  }
  return routePath === path;
}

/** Bounces old `/inbox` links and bookmarks home (CL-6151: the Inbox page
 * is gone — tasks and approvals don't flow into a workbench). */
function InboxRedirect({
  navigate,
}: {
  readonly navigate: (to: string) => void;
}) {
  useEffect(() => {
    navigate("/");
  }, [navigate]);
  return null;
}

export const APP_ROUTES: readonly AppRoute[] = [
  {
    path: "/",
    label: "New Workbench",
    icon: <ChatCircle />,
    render: () => <HomeRoute />,
    hasStageTopBar: false,
  },
  {
    path: NEW_WORKBENCH_PATH,
    label: "New workbench",
    icon: <ChatCircle />,
    render: () => <NewWorkbenchPickerRoute />,
  },
  {
    path: WORKBENCH_PATH_PREFIX,
    label: "Workbenches",
    icon: <ChatCircle />,
    render: (path: string, navigate: (to: string) => void) => (
      <ChatPage path={path} navigate={navigate} />
    ),
  },
  {
    path: "/inbox",
    label: "Inbox",
    icon: <ChatCircle />,
    render: (_path: string, navigate: (to: string) => void) => (
      <InboxRedirect navigate={navigate} />
    ),
  },
  {
    path: "/routines",
    label: "Routines",
    icon: <FlowArrow />,
    render: (path: string, navigate: (to: string) => void) => (
      <RoutinesRoute path={path} navigate={navigate} />
    ),
  },
  {
    // The renamed, remounted Library page (CL-6353) — "Library" stays out
    // of user-facing copy, but the underlying artifact machinery
    // (`library-page.tsx`, `libraryArtifactIdFromPath`, …) keeps its name.
    path: "/files",
    label: "Files",
    icon: <FolderOpen />,
    render: (path: string) => <LibraryRoute path={path} />,
  },
  {
    // Old `/library` links and bookmarks (CL-6353's rename) land here.
    path: "/library",
    label: "Files",
    icon: <FolderOpen />,
    render: (path: string, navigate: (to: string) => void) => (
      <LegacyLibraryRedirect path={path} navigate={navigate} />
    ),
  },
  {
    path: "/agents",
    label: "Agents",
    icon: <Robot />,
    render: (path: string, navigate: (to: string) => void) => (
      <AgentsRoute path={path} navigate={navigate} />
    ),
  },
  {
    // Agents spent CL-5990 through CL-6354 as a Settings section — this
    // entry keeps old `/settings/agents[/:id]` links routable.
    path: "/settings/agents",
    label: "Agents",
    icon: <Robot />,
    render: (path: string, navigate: (to: string) => void) => (
      <LegacySettingsAgentsRedirect path={path} navigate={navigate} />
    ),
  },
  {
    path: "/skills",
    label: "Skills",
    icon: <Lightning />,
    render: (path: string, navigate: (to: string) => void) => (
      <SkillsRoute path={path} navigate={navigate} />
    ),
  },
  {
    // Skills spent CL-5990 through CL-6355 as a Settings section — this
    // entry keeps old `/settings/skills[/:id]` links routable.
    path: "/settings/skills",
    label: "Skills",
    icon: <Lightning />,
    render: (path: string, navigate: (to: string) => void) => (
      <LegacySettingsSkillsRedirect path={path} navigate={navigate} />
    ),
  },
  {
    path: "/insights",
    label: "Insights",
    icon: <ChartBar />,
    render: (path: string) => <InsightsRoute path={path} />,
  },
  {
    // Route entry only — CL-6090 builds the page; the footer link into it
    // is CL-6088's (the single-column shell rework), so this is
    // deliberately absent from RAIL_PRIMARY_PATHS / RAIL_UTILITY_PATHS /
    // NAV_ROUTES below.
    path: "/plugins",
    label: "Plugins",
    icon: <SquaresFour />,
    render: (path: string, navigate: (to: string) => void) => (
      <PluginsRoute path={path} navigate={navigate} />
    ),
  },
  {
    path: SETTINGS_PATH,
    label: "Settings",
    icon: <SlidersHorizontal />,
    render: (path: string, navigate: (to: string) => void) => (
      <SettingsRoute path={path} navigate={navigate} />
    ),
  },
];

function routesInOrder(paths: readonly string[]): readonly AppRoute[] {
  const byPath = new Map(APP_ROUTES.map((route) => [route.path, route]));
  return paths.flatMap((path) => {
    const route = byPath.get(path);
    return route === undefined ? [] : [route];
  });
}

/**
 * Everything the command palette treats as a product destination (its
 * "Pages" group). The sidebar footer reaches Files / Skills / Agents /
 * Plugins / Insights / Settings directly; the rest are palette- and
 * deep-link-reachable.
 */
export const NAV_ROUTES: readonly AppRoute[] = routesInOrder([
  WORKBENCH_PATH_PREFIX,
  "/routines",
  "/files",
  "/skills",
  "/agents",
  "/insights",
  SETTINGS_PATH,
]);
