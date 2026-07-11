import { useState } from "react";
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  useLocation,
  useParams,
} from "react-router";
import { Menu } from "lucide-react";
import type { PaletteResultItem } from "@workbench/shared";
import { useAuth } from "./components/AuthProvider";
import { AppSidebar } from "./components/layout/AppSidebar";
import { NotificationsBell } from "./components/layout/NotificationsBell";
import { CommandPaletteProvider } from "./components/command-palette-context";
import { PersonalAgentChat } from "./components/PersonalAgentChat";
import { ChatLauncherProvider } from "./lib/chat-launcher-context";
import { ActiveWorkbenchProvider } from "./lib/active-workbench-context";
import { RequireWorkbenchAccess } from "./components/RequireWorkbenchAccess";
import { ActiveContextProvider } from "./lib/active-context-store";
import { ConnectionStatusProvider } from "./lib/connection-status-context";
import { OnboardingTourProvider } from "./components/tour/OnboardingTour";
import { WorkbenchLoadingScreen } from "./components/WorkbenchBootScreen";
import { LoginPage } from "./pages/LoginPage";
import { ChatThreadPage } from "./pages/ChatThreadPage";
import { ChatsListPage } from "./pages/ChatsListPage";
import { ArtifactsPage } from "./pages/ArtifactsPage";
import { ArtifactDetailPage } from "./pages/ArtifactDetailPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import { InboxPage } from "./pages/InboxPage";
import Settings from "./pages/Settings";
import { SkillsLibrary } from "./pages/SkillsLibrary";
import { SkillsNew } from "./pages/SkillsNew";
import { SkillDetail } from "./pages/SkillDetail";
import { ToolsLibrary } from "./pages/ToolsLibrary";
import { ToolDetail } from "./pages/ToolDetail";
import { SettingsToolDetail } from "./pages/SettingsToolDetail";
import { InsightsDashboard } from "./pages/InsightsDashboard";
import { ActorDetailPage } from "./pages/insights/ActorDetailPage";
import { WorkflowTracePage } from "./pages/insights/WorkflowTracePage";
import { WorkflowRunHistory } from "./pages/insights/WorkflowRunHistory";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { AdminPrincipals } from "./pages/admin/AdminPrincipals";
import { PrincipalDetail } from "./pages/admin/PrincipalDetail";
import { AdminDefinitions } from "./pages/admin/AdminDefinitions";
import { DefinitionDetail } from "./pages/admin/DefinitionDetail";
import { AdminAudit } from "./pages/admin/AdminAudit";
import { RequireAdmin } from "./pages/admin/RequireAdmin";
import { OwnerLayout } from "./pages/admin/OwnerLayout";
import { OwnerCatalog } from "./pages/admin/OwnerCatalog";
import { OwnerGammaTemplates } from "./pages/admin/OwnerGammaTemplates";
import { OwnerCapabilities } from "./pages/admin/OwnerCapabilities";
import { OwnerWorkflows } from "./pages/admin/OwnerWorkflows";
import { OwnerDemos } from "./pages/admin/OwnerDemos";

// Preserves the tool name when redirecting the legacy /tools/:name path to its
// new home under /admin.
function RedirectToAdminTool() {
  const { name } = useParams();
  return <Navigate to={`/admin/tools/${name ?? ""}`} replace />;
}

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
    id: "nav:inbox",
    category: "navigation",
    title: "Inbox",
    to: "/inbox",
    keywords: ["mail", "mailbox", "messages", "email", "notifications"],
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
    to: "/admin/tools",
    keywords: ["integrations", "providers", "library", "admin"],
    requires: "admin",
  },
  {
    id: "nav:admin",
    category: "navigation",
    title: "Admin",
    to: "/admin",
    keywords: ["governance", "grants", "roles", "principals", "audit"],
    requires: "admin",
  },
  {
    id: "nav:owner",
    category: "navigation",
    title: "Owner",
    to: "/owner",
    keywords: ["owner", "workbench"],
    requires: "owner",
  },
  {
    id: "nav:insights",
    category: "navigation",
    title: "Insights",
    to: "/insights",
    keywords: ["analytics", "usage", "dashboard", "metrics"],
  },
  {
    id: "nav:run-history",
    category: "navigation",
    title: "Run history",
    to: "/insights/runs",
    keywords: ["workflow", "runs", "history", "past", "executions"],
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
  const location = useLocation();

  if (session.status === "unauthenticated")
    return (
      <Navigate to={{ pathname: "/login", search: location.search }} replace />
    );
  if (session.status === "loading") return <WorkbenchLoadingScreen />;
  return <Outlet />;
}

function AppShell() {
  // Drawer state only drives the mobile layout; at desktop widths the sidebar
  // is a static column and ignores `mobileOpen` (see AppSidebar's max-md: rules).
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <ActiveWorkbenchProvider>
      <RequireWorkbenchAccess>
        <ChatLauncherProvider>
          <CommandPaletteProvider>
            <ActiveContextProvider>
              <ConnectionStatusProvider>
                <OnboardingTourProvider>
                  <div className="flex h-dvh flex-row overflow-hidden bg-page">
                    <AppSidebar
                      mobileOpen={drawerOpen}
                      onNavigate={() => setDrawerOpen(false)}
                    />
                    {drawerOpen && (
                      <button
                        type="button"
                        aria-label="Close menu"
                        onClick={() => setDrawerOpen(false)}
                        className="fixed inset-0 z-40 bg-black/40 md:hidden"
                      />
                    )}
                    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
                        <button
                          type="button"
                          onClick={() => setDrawerOpen(true)}
                          aria-label="Open menu"
                          className="grid h-9 w-9 place-items-center rounded-[10px] text-text-2 transition-colors hover:bg-page hover:text-text md:hidden"
                        >
                          <Menu size={20} />
                        </button>
                        <span className="text-sm font-semibold text-text md:hidden">
                          Workbench
                        </span>
                        <div className="ml-auto">
                          <NotificationsBell />
                        </div>
                      </header>
                      <main
                        data-tour="myra-chat"
                        className="flex-1 overflow-hidden"
                      >
                        <Outlet />
                      </main>
                      <PersonalAgentChat />
                    </div>
                  </div>
                </OnboardingTourProvider>
              </ConnectionStatusProvider>
            </ActiveContextProvider>
          </CommandPaletteProvider>
        </ChatLauncherProvider>
      </RequireWorkbenchAccess>
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
          // Inbox-first: login lands on the living dashboard (the inbox with
          // its Now feed). Chat stays reachable at /chats and /chats/:threadId.
          { index: true, element: <InboxPage /> },
          { path: "/chats", element: <ChatsListPage /> },
          { path: "/chats/:threadId", element: <ChatThreadPage /> },
          { path: "/onboarding", element: <Navigate to="/" replace /> },
          { path: "/dashboard", element: <Navigate to="/" replace /> },
          { path: "/inbox", element: <InboxPage /> },
          { path: "/inbox/:messageId", element: <InboxPage /> },
          { path: "/artifacts", element: <ArtifactsPage /> },
          { path: "/artifacts/:artifactId", element: <ArtifactDetailPage /> },
          {
            path: "/workbenches/:slug",
            element: <Navigate to="/artifacts" replace />,
          },
          { path: "/workflows", element: <WorkflowsPage /> },
          { path: "/workflows/:workflowId", element: <WorkflowsPage /> },
          { path: "/settings", element: <Settings /> },
          { path: "/settings/tools/:id", element: <SettingsToolDetail /> },
          { path: "/skills", element: <SkillsLibrary /> },
          { path: "/skills/new", element: <SkillsNew /> },
          { path: "/skills/:id", element: <SkillDetail /> },
          // Tools moved under Admin (CL-2719). Old paths redirect.
          { path: "/tools", element: <Navigate to="/admin/tools" replace /> },
          { path: "/tools/:name", element: <RedirectToAdminTool /> },
          {
            path: "/admin/tools",
            element: (
              <RequireAdmin>
                <ToolsLibrary />
              </RequireAdmin>
            ),
          },
          {
            path: "/admin/tools/:name",
            element: (
              <RequireAdmin>
                <ToolDetail />
              </RequireAdmin>
            ),
          },
          {
            path: "/admin",
            element: <AdminLayout />,
            children: [
              {
                index: true,
                element: <Navigate to="/admin/principals" replace />,
              },
              { path: "principals", element: <AdminPrincipals /> },
              { path: "principals/:id", element: <PrincipalDetail /> },
              { path: "definitions", element: <AdminDefinitions /> },
              { path: "definitions/:key", element: <DefinitionDetail /> },
              { path: "audit", element: <AdminAudit /> },
            ],
          },
          {
            path: "/owner",
            element: <OwnerLayout />,
            children: [
              {
                index: true,
                element: <Navigate to="/owner/catalog" replace />,
              },
              { path: "catalog", element: <OwnerCatalog /> },
              { path: "capabilities", element: <OwnerCapabilities /> },
              { path: "capabilities/gamma", element: <OwnerGammaTemplates /> },
              { path: "workflows", element: <OwnerWorkflows /> },
              { path: "demos", element: <OwnerDemos /> },
              // Legacy owner routes → their new homes.
              {
                path: "templates",
                element: <Navigate to="/owner/capabilities/gamma" replace />,
              },
              {
                path: "models",
                element: <Navigate to="/owner/catalog" replace />,
              },
              {
                path: "setup",
                element: <Navigate to="/owner/catalog" replace />,
              },
            ],
          },
          { path: "/insights", element: <InsightsDashboard /> },
          { path: "/insights/runs", element: <WorkflowRunHistory /> },
          { path: "/insights/users/:id", element: <ActorDetailPage /> },
          {
            path: "/insights/trace/:runId",
            element: <WorkflowTracePage />,
          },
        ],
      },
    ],
  },
]);
