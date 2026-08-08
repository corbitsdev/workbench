// The route table: one entry per screen, consumed by both the sidebar (label,
// icon) and the route switch (render), so navigation and pages cannot drift
// apart.

import {
  Activity,
  Building2,
  Home,
  Library,
  MessageSquare,
  Settings,
  ShieldCheck,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { ApprovalsRoute } from "./pages/approvals-page";
import { BenchesRoute } from "./pages/benches-page";
import { ChatPage } from "./pages/chat-page";
import { HomeRoute } from "./pages/home-page";
import { LibraryRoute } from "./pages/library-page";
import { RunsRoute } from "./pages/runs-page";
import { SettingsRoute } from "./pages/settings-page";

/** Landing point for a session the first-login hook just provisioned a
 * personal bench for. Not one of `APP_ROUTES`: it has no sidebar entry,
 * it is only ever reached by the first-login redirect. */
export const ONBOARDING_PATH = "/onboarding";

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
    path: "/runs",
    label: "Runs",
    icon: <Activity />,
    render: () => <RunsRoute />,
  },
  {
    path: "/library",
    label: "Library",
    icon: <Library />,
    render: () => <LibraryRoute />,
  },
  {
    path: "/approvals",
    label: "Approvals",
    icon: <ShieldCheck />,
    render: () => <ApprovalsRoute />,
  },
  {
    path: "/benches",
    label: "Benches",
    icon: <Building2 />,
    render: () => <BenchesRoute />,
  },
  {
    path: "/settings",
    label: "Settings",
    icon: <Settings />,
    render: () => <SettingsRoute />,
  },
];
