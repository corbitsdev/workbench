import { createBrowserRouter, Navigate, Outlet } from "react-router";
import type { PaletteResultItem } from "@workbench/shared";
import { useAuth } from "./components/AuthProvider";
import { AppSidebar } from "./components/layout/AppSidebar";
import { CommandPaletteProvider } from "./components/command-palette-context";
import { PersonalAgentChat } from "./components/PersonalAgentChat";
import { ChatLauncherProvider } from "./lib/chat-launcher-context";
import { ActiveWorkbenchProvider } from "./lib/active-workbench-context";
import { LoginPage } from "./pages/LoginPage";
import { ChatThreadPage } from "./pages/ChatThreadPage";
import { ChatsListPage } from "./pages/ChatsListPage";
import { ArtifactsPage } from "./pages/ArtifactsPage";
import { ArtifactDetailPage } from "./pages/ArtifactDetailPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import Settings from "./pages/Settings";
import { SkillsLibrary } from "./pages/SkillsLibrary";
import { SkillsNew } from "./pages/SkillsNew";
import { SkillDetail } from "./pages/SkillDetail";
import { ToolsLibrary } from "./pages/ToolsLibrary";
import { ToolDetail } from "./pages/ToolDetail";
import { InsightsDashboard } from "./pages/InsightsDashboard";

// Static navigation commands for the command palette, kept beside the route
// table so a new top-level route adds its palette entry in the same place. Each
// `to` must resolve to a path registered in the router below.
export const NAV_COMMANDS: PaletteResultItem[] = [
  {
    id: "nav:chats",
    category: "navigation",
    title: "Chats",
    to: "/chats",
    keywords: ["conversations", "myra", "messages"],
  },
  {
    id: "nav:artifacts",
    category: "navigation",
    title: "Artifacts",
    to: "/artifacts",
    keywords: ["collateral", "outputs", "documents", "library"],
  },
  {
    id: "nav:workflows",
    category: "navigation",
    title: "Workflows",
    to: "/workflows",
    keywords: ["runs", "pipelines", "jobs"],
  },
  {
    id: "nav:skills",
    category: "navigation",
    title: "Skills",
    to: "/skills",
    keywords: ["playbooks", "prompts", "library"],
  },
  {
    id: "nav:tools",
    category: "navigation",
    title: "Tools",
    to: "/tools",
    keywords: ["integrations", "providers", "library"],
  },
  {
    id: "nav:insights",
    category: "navigation",
    title: "Insights",
    to: "/insights",
    keywords: ["analytics", "usage", "dashboard", "metrics"],
  },
  {
    id: "nav:settings",
    category: "navigation",
    title: "Settings",
    to: "/settings",
    keywords: ["preferences", "theme", "account"],
  },
];

function ProtectedLayout() {
  const { session } = useAuth();

  if (session.status === "unauthenticated")
    return <Navigate to="/login" replace />;
  if (session.status === "loading") return null;
  return <Outlet />;
}

function AppShell() {
  return (
    <ActiveWorkbenchProvider>
      <ChatLauncherProvider>
        <CommandPaletteProvider>
          <div className="flex h-screen flex-row bg-page">
            <AppSidebar />
            <div className="flex flex-1 flex-col overflow-hidden">
              <main className="flex-1 overflow-hidden">
                <Outlet />
              </main>
              <PersonalAgentChat />
            </div>
          </div>
        </CommandPaletteProvider>
      </ChatLauncherProvider>
    </ActiveWorkbenchProvider>
  );
}

export const router = createBrowserRouter([
  {
    path: "/login",
    element: <LoginPage />,
  },
  {
    element: <ProtectedLayout />,
    children: [
      {
        element: <AppShell />,
        children: [
          // Chat-first: the index redirects into the last-active conversation;
          // /chats is the searchable list; /chats/:threadId is a conversation.
          { index: true, element: <ChatThreadPage /> },
          { path: "/chats", element: <ChatsListPage /> },
          { path: "/chats/:threadId", element: <ChatThreadPage /> },
          { path: "/onboarding", element: <Navigate to="/" replace /> },
          { path: "/dashboard", element: <Navigate to="/" replace /> },
          { path: "/artifacts", element: <ArtifactsPage /> },
          { path: "/artifacts/:artifactId", element: <ArtifactDetailPage /> },
          {
            path: "/workbenches/:slug",
            element: <Navigate to="/artifacts" replace />,
          },
          { path: "/workflows", element: <WorkflowsPage /> },
          { path: "/workflows/:workflowId", element: <WorkflowsPage /> },
          { path: "/settings", element: <Settings /> },
          { path: "/skills", element: <SkillsLibrary /> },
          { path: "/skills/new", element: <SkillsNew /> },
          { path: "/skills/:id", element: <SkillDetail /> },
          { path: "/tools", element: <ToolsLibrary /> },
          { path: "/tools/:name", element: <ToolDetail /> },
          { path: "/insights", element: <InsightsDashboard /> },
        ],
      },
    ],
  },
]);
