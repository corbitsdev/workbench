// The route table: one entry per screen, consumed by both the sidebar (label,
// icon) and the route switch (render), so navigation and pages cannot drift
// apart.

import {
  Activity,
  Home,
  Library,
  MessageSquare,
  Settings,
  ShieldCheck,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { ApprovalsRoute } from "./pages/approvals-page";
import { ChatPage } from "./pages/chat-page";
import { HomeRoute } from "./pages/home-page";
import { LibraryRoute } from "./pages/library-page";
import { RunsRoute } from "./pages/runs-page";
import { SettingsRoute } from "./pages/settings-page";

export type AppRoute = {
  readonly path: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly render: () => ReactElement;
};

export const APP_ROUTES: readonly AppRoute[] = [
  { path: "/", label: "Home", icon: <Home />, render: () => <HomeRoute /> },
  {
    path: "/chat",
    label: "Chat",
    icon: <MessageSquare />,
    render: () => <ChatPage />,
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
    path: "/settings",
    label: "Settings",
    icon: <Settings />,
    render: () => <SettingsRoute />,
  },
];
