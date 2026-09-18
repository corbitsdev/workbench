// The route table: one entry per screen, consumed by the command palette
// (label) and the route switch (render), so navigation and pages cannot
// drift apart. The sidebar itself lists workbenches (conversations), not
// routes — the primary footer reaches Artifacts, Skills, Tools, and
// Workflows. Insights moved under Settings, reachable there and by deep
// link and the palette. Conversation deep links
// (`/w/:workbenchId`) stay routable; `/` is the Myra land hop (ensure +
// open her conversation) for a bench with a workbench already, or the
// guided first-workbench describe screen for a bench with none — never a
// Home dashboard.
// Approvals has no page — the Activity band owns them. Agents and Skills
// are their own rail destinations again. Every path this app has retired
// along the way (`/settings/agents`, `/routines`, `/files`, `/library`,
// `/inbox`, `/mission-control`) lives in `RETIRED_PREFIXES` below, which
// the router resolves before a screen mounts — never a route entry whose
// only job is to bounce.

import {
  ChatCircle,
  ChartBar,
  FlowArrow,
  FolderOpen,
  Lightning,
  Plugs,
  Robot,
  SlidersHorizontal,
} from "@/lib/icons";
import { CHAT_STRINGS } from "@/chat";
import type { Slug } from "@/lib/slug";
import { lazy, type ReactElement, type ReactNode } from "react";

import {
  AGENTS_PATH_PREFIX,
  SKILLS_PATH_PREFIX,
  WORKFLOWS_PATH_PREFIX,
  detailSlugFromPath,
  routineSegmentFromPath,
} from "./path-ids";
import { WORKBENCH_PATH_PREFIX, isWorkbenchPath } from "./workbench-path";
import { CHATS_PATH_PREFIX, isChatPath } from "./chat-path";

// Each signed-in page is a dynamic import so Vite emits one chunk per
// screen. Static imports here pulled chat-ui, artifact-ui, settings-ui,
// and insights into a single 1.2 MB SPA.

const HomeRoute = lazy(async () => ({
  default: (await import("./pages/home-page")).HomeRoute,
}));
const NewWorkbenchPickerRoute = lazy(async () => ({
  default: (await import("./pages/new-workbench-picker")).NewWorkbenchPickerRoute,
}));
const WorkbenchRoomRoute = lazy(async () => ({
  default: (await import("./pages/workbench-room-page")).WorkbenchRoomRoute,
}));
const ChatThreadRoute = lazy(async () => ({
  default: (await import("./pages/chat-thread-page")).ChatThreadRoute,
}));
const WorkflowsRoute = lazy(async () => ({
  default: (await import("./pages/routines-page")).RoutinesRoute,
}));
const ArtifactsRoute = lazy(async () => ({
  default: (await import("./pages/library-page")).LibraryRoute,
}));
const AgentsRoute = lazy(async () => ({
  default: (await import("./pages/agents-page")).AgentsRoute,
}));
const SkillsRoute = lazy(async () => ({
  default: (await import("./pages/skills-page")).SkillsRoute,
}));
const ToolsRoute = lazy(async () => ({
  default: (await import("./pages/tools-page")).ToolsRoute,
}));
const InsightsRoute = lazy(async () => ({
  default: (await import("./pages/insights-page")).InsightsRoute,
}));
const SettingsRoute = lazy(async () => ({
  default: (await import("./pages/settings-page")).SettingsRoute,
}));
const AgentDetailRoute = lazy(async () => ({
  default: (await import("./pages/agent-detail-page")).AgentDetailRoute,
}));
const SkillDetailRoute = lazy(async () => ({
  default: (await import("./pages/skill-detail-page")).SkillDetailRoute,
}));
const RoutineDetailRoute = lazy(async () => ({
  default: (await import("./pages/routine-detail-page")).RoutineDetailRoute,
}));

/** The signed-out screen — a real route, not a conditional swap:
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

/** The template picker — every "+ New workbench" affordance
 * (sidebar, command palette) hops here first; picking a row is what
 * actually mints the workbench. Not in `NAV_ROUTES`: it has no sidebar
 * row of its own, only the "+" control and the palette reach it. */
export const NEW_WORKBENCH_PATH = "/new";

/** Detail routes are addressed by slug: one route path per
 * entity, ending in this segment. A path matches only when its last
 * segment is a real slug, so `/agents/wfd_1` still resolves to the Agents
 * roster (which owns id deep links) while `/agents/triage-bot` resolves to
 * the agent's own screen. */
const SLUG_SEGMENT = "/:slug";

export const AGENT_DETAIL_PATH = `${AGENTS_PATH_PREFIX}${SLUG_SEGMENT}`;
export const SKILL_DETAIL_PATH = `${SKILLS_PATH_PREFIX}${SLUG_SEGMENT}`;

/**
 * Workflows are addressed by id, not by slug. DESIGN.md allows a slug in a
 * route only where it is "immutable and tenant-unique, enforced as a hard
 * database constraint — never a soft convention"; a workflow has no slug
 * column, so a name-derived one is exactly the soft convention that rule
 * forbids, and the documented fallback is the opaque id. So this route
 * claims any single segment under `/workflows`: an id renders the page,
 * and a name still resolves — `routine-detail-page.tsx` redirects it to
 * the id path — which keeps human-typed and shared-by-name links working
 * without making the fragile address canonical. A real slug column is
 * ticketed separately.
 */
const ROUTINE_SEGMENT = "/:routine";
export const ROUTINE_DETAIL_PATH = `${WORKFLOWS_PATH_PREFIX}${ROUTINE_SEGMENT}`;

function slugForDetailRoute(routePath: string, path: string): Slug | null {
  return detailSlugFromPath(path, routePath.slice(0, -SLUG_SEGMENT.length));
}

/** The routine detail route only ever renders for a path `matchesRoute`
 * already accepted, which is what makes the segment non-null here. */
function routineDetailSegment(path: string): string {
  const segment = routineSegmentFromPath(path);
  if (segment === null) {
    throw new Error(`${ROUTINE_DETAIL_PATH} rendered for a path with no routine: ${path}`);
  }
  return segment;
}

/** A detail route only ever renders for a path `matchesRoute` already
 * accepted, which is what makes the slug non-null here. */
function detailRouteSlug(routePath: string, path: string): Slug {
  const slug = slugForDetailRoute(routePath, path);
  if (slug === null) {
    throw new Error(`${routePath} rendered for a path with no slug: ${path}`);
  }
  return slug;
}

export type AppRoute = {
  readonly path: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly render: (path: string, navigate: (to: string) => void) => ReactElement;
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
 * conversation deep links (which also match when Myra land `/` is active)
 * and the slug-addressed detail routes (`/agents/:slug`). Other routes are
 * exact path matches. A roster prefix still matches its own nested paths,
 * so the sidebar footer row stays lit on a detail screen.
 */
export function matchesRoute(routePath: string, path: string): boolean {
  if (routePath === CHATS_PATH_PREFIX) {
    return isChatPath(path);
  }
  if (routePath === WORKBENCH_PATH_PREFIX) {
    return isWorkbenchPath(path) || path === "/";
  }
  if (routePath === ROUTINE_DETAIL_PATH) {
    const segment = routineSegmentFromPath(path);
    return segment !== null && !segment.includes("/");
  }
  if (routePath.endsWith(SLUG_SEGMENT)) {
    return slugForDetailRoute(routePath, path) !== null;
  }
  if (
    routePath === "/workflows" ||
    routePath === "/artifacts" ||
    routePath === "/insights" ||
    routePath === "/agents" ||
    routePath === "/skills" ||
    routePath === SETTINGS_PATH
  ) {
    return path === routePath || path.startsWith(`${routePath}/`);
  }
  return routePath === path;
}

/** Every retired path prefix and where it lives now. Resolved by the router
 * before a screen mounts, so a bookmark never renders a page just to bounce
 * off it. */
const RETIRED_PREFIXES: readonly (readonly [string, string])[] = [
  ["/mission-control", "/"],
  ["/inbox", "/"],
  ["/routines", "/workflows"],
  ["/files", "/artifacts"],
  ["/library", "/artifacts"],
  ["/settings/agents", "/agents"],
  ["/settings/skills", "/skills"],
];

/** The current home for a retired path, `null` for a path that is still its
 * own. A deep-linked id is carried across (`/files/a1` → `/artifacts/a1`). */
export function redirectTargetFor(path: string): string | null {
  for (const [oldPrefix, newPrefix] of RETIRED_PREFIXES) {
    if (path === oldPrefix) return newPrefix;
    if (path.startsWith(`${oldPrefix}/`)) {
      const rest = path.slice(oldPrefix.length + 1);
      return newPrefix === "/" ? "/" : `${newPrefix}/${rest}`;
    }
  }
  return null;
}

export const APP_ROUTES: readonly AppRoute[] = [
  {
    path: "/",
    label: CHAT_STRINGS.newWorkbenchAction,
    icon: <ChatCircle />,
    render: () => <HomeRoute />,
    hasStageTopBar: false,
  },
  {
    path: NEW_WORKBENCH_PATH,
    label: CHAT_STRINGS.newWorkbenchAction,
    icon: <ChatCircle />,
    render: () => <NewWorkbenchPickerRoute />,
  },
  {
    path: CHATS_PATH_PREFIX,
    label: "Chats",
    icon: <ChatCircle />,
    render: (path: string, navigate: (to: string) => void) => (
      <ChatThreadRoute path={path} navigate={navigate} />
    ),
  },
  {
    path: WORKBENCH_PATH_PREFIX,
    label: "Workbenches",
    icon: <ChatCircle />,
    render: (path: string) => <WorkbenchRoomRoute path={path} />,
  },
  {
    // Detail routes come before their roster: the roster prefix matches
    // everything beneath it, so the more specific slug route has to be
    // found first.
    path: ROUTINE_DETAIL_PATH,
    label: "Workflow",
    icon: <FlowArrow />,
    render: (path: string) => <RoutineDetailRoute segment={routineDetailSegment(path)} />,
  },
  {
    path: "/workflows",
    label: "Workflows",
    icon: <FlowArrow />,
    render: () => <WorkflowsRoute />,
  },
  {
    // The renamed, remounted Library page — "Library" stays out
    // of user-facing copy, but the underlying artifact machinery
    // (`library-page.tsx`, `libraryArtifactIdFromPath`, …) keeps its name.
    path: "/artifacts",
    label: "Artifacts",
    icon: <FolderOpen />,
    render: (path: string) => <ArtifactsRoute path={path} />,
  },
  {
    path: AGENT_DETAIL_PATH,
    label: "Agent",
    icon: <Robot />,
    render: (path: string, navigate: (to: string) => void) => (
      <AgentDetailRoute slug={detailRouteSlug(AGENT_DETAIL_PATH, path)} navigate={navigate} />
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
    path: SKILL_DETAIL_PATH,
    label: "Skill",
    icon: <Lightning />,
    render: (path: string) => <SkillDetailRoute path={path} />,
  },
  {
    path: "/skills",
    label: "Skills",
    icon: <Lightning />,
    render: (_path: string, navigate: (to: string) => void) => <SkillsRoute navigate={navigate} />,
  },
  {
    path: "/tools",
    label: "Tools",
    icon: <Plugs />,
    render: () => <ToolsRoute />,
  },
  {
    path: "/insights",
    label: "Insights",
    icon: <ChartBar />,
    render: (path: string) => <InsightsRoute path={path} />,
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
 * "Pages" group). The primary sidebar footer reaches Artifacts / Skills /
 * Tools / Workflows; Insights lives under Settings now. Agents, Insights
 * and Settings stay palette- and deep-link-reachable even though they are
 * off the primary rail.
 */
export const NAV_ROUTES: readonly AppRoute[] = routesInOrder([
  "/artifacts",
  "/skills",
  "/tools",
  "/workflows",
  "/agents",
  "/insights",
  SETTINGS_PATH,
]);
