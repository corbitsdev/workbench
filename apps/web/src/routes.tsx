// The route table: one entry per screen, consumed by both the sidebar (label,
// icon) and the route switch (render), so navigation and pages cannot drift
// apart. Settings renders like any other route but is reached from the
// sidebar's identity dock, not the top nav — `NAV_ROUTES` is what the nav
// list shows.

import {
  Bot,
  Clock,
  Home,
  Library,
  MessageSquare,
  Settings,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { AgentsRoute } from "./pages/agents-page";
import { ApprovalsRoute } from "./pages/approvals-page";
import { ChatPage } from "./pages/chat-page";
import { HomeRoute } from "./pages/home-page";
import { LibraryRoute } from "./pages/library-page";
import { RoutinesRoute } from "./pages/routines-page";
import { SettingsRoute } from "./pages/settings-page";
import { SkillsRoute } from "./pages/skills-page";

/** Landing point for a session the first-login hook just provisioned a
 * personal bench for. Not one of `APP_ROUTES`: it has no sidebar entry,
 * it is only ever reached by the first-login redirect. */
export const ONBOARDING_PATH = "/onboarding";

/** Settings lives in the sidebar's identity dock, not the top nav. */
export const SETTINGS_PATH = "/settings";

export type AppRoute = {
  readonly path: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly render: (
    path: string,
    navigate: (to: string) => void,
  ) => ReactElement;
};

/**
 * Matches /chat and /chat/:channelId — the channel id segment is the
 * chat page's own concern; the shell only needs to know the page owns
 * the whole /chat prefix.
 */
export function matchesRoute(routePath: string, path: string): boolean {
  if (routePath === "/chat") {
    return path === "/chat" || path.startsWith("/chat/");
  }
  if (routePath === "/routines") {
    return path === "/routines" || path.startsWith("/routines/");
  }
  return routePath === path;
}

export const APP_ROUTES: readonly AppRoute[] = [
  { path: "/", label: "Home", icon: <Home />, render: () => <HomeRoute /> },
  {
    path: "/chat",
    label: "Chat",
    icon: <MessageSquare />,
    render: (path: string, navigate: (to: string) => void) => (
      <ChatPage path={path} navigate={navigate} />
    ),
  },
  {
    path: "/routines",
    label: "Routines",
    icon: <Clock />,
    render: (path: string, navigate: (to: string) => void) => (
      <RoutinesRoute path={path} navigate={navigate} />
    ),
  },
  {
    path: "/library",
    label: "Library",
    icon: <Library />,
    render: () => <LibraryRoute />,
  },
  {
    path: "/agents",
    label: "Agents",
    icon: <Bot />,
    render: () => <AgentsRoute />,
  },
  {
    path: "/skills",
    label: "Skills",
    icon: <Sparkles />,
    render: () => <SkillsRoute />,
  },
  {
    path: "/approvals",
    label: "Approvals",
    icon: <ShieldCheck />,
    render: () => <ApprovalsRoute />,
  },
  {
    path: SETTINGS_PATH,
    label: "Settings",
    icon: <Settings />,
    render: () => <SettingsRoute />,
  },
];

/** What the sidebar's top nav lists: every route except Settings, which
 * the identity dock owns. */
export const NAV_ROUTES: readonly AppRoute[] = APP_ROUTES.filter(
  (route) => route.path !== SETTINGS_PATH,
);
