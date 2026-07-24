import { useState } from "react";
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  useLocation,
  useParams,
} from "react-router";
import type { PaletteResultItem } from "@workbench/shared";
import { useAuth } from "./components/AuthProvider";
import { AppSidebar } from "./components/layout/AppSidebar";
import { AppTopBar } from "./components/AppTopBar";
import { PageChromeProvider } from "./lib/page-chrome";
import { CommandPaletteProvider } from "./components/command-palette-context";
import { PersonalAgentChat } from "./components/PersonalAgentChat";
import { ChatLauncherProvider } from "./lib/chat-launcher-context";
import { ActiveWorkbenchProvider } from "./lib/active-workbench-context";
import { RequireWorkbenchAccess } from "./components/RequireWorkbenchAccess";
import { ActiveContextProvider } from "./lib/active-context-store";
import { ConnectionStatusProvider } from "./lib/connection-status-context";
import { OnboardingTourProvider } from "./components/tour/OnboardingTour";
import { WhatsNewPopup } from "./components/whats-new/WhatsNewPopup";
import { WorkbenchLoadingScreen } from "./components/WorkbenchBootScreen";
import { LoginPage } from "./pages/LoginPage";
import { ChatThreadPage } from "./pages/ChatThreadPage";
import { ChatsListPage } from "./pages/ChatsListPage";
import { ArtifactsPage } from "./pages/ArtifactsPage";
import { ArtifactDetailPage } from "./pages/ArtifactDetailPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import { InboxPage } from "./pages/InboxPage";
import Settings from "./pages/Settings";
import SettingsLayout from "./pages/SettingsLayout";
import LibraryLayout from "./pages/LibraryLayout";
import { SkillsLibrary } from "./pages/SkillsLibrary";
import { AgentsPage } from "./pages/AgentsPage";
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
import { OwnerSchedules } from "./pages/admin/OwnerSchedules";
import { OwnerWorkUnits } from "./pages/admin/OwnerWorkUnits";
import { OwnerMembers } from "./pages/admin/OwnerMembers";
import { OwnerDemos } from "./pages/admin/OwnerDemos";
import {
  mapLegacyAdminPath,
  mapLegacyOwnerPath,
} from "./lib/legacy-admin-owner-redirects";

// Preserves the tool name when redirecting the legacy /tools/:name path to its
// new home under /settings/admin.
function RedirectToAdminTool() {
  const { name } = useParams();
  return <Navigate to={`/settings/admin/tools/${name ?? ""}`} replace />;
}

// Routines folded into the unified Workflows surface: list and schedule
// detail deep links resolve there so bookmarks keep working.
function RedirectRoutinesToWorkflows() {
  const location = useLocation();
  return (
    <Navigate
      to={{
        pathname: "/workflows",
        search: location.search,
        hash: location.hash,
      }}
      replace
    />
  );
}

function RedirectRoutineDetailToWorkflows() {
  const { id } = useParams();
  return (
    <Navigate
      to={{
        pathname: "/workflows",
        search: `?schedule=${encodeURIComponent(id ?? "")}`,
      }}
      replace
    />
  );
}

// Library (CL-4256): Artifacts, Skills, and Agents are one top-level nav
// entry — same tier as Workflows and Routines — reading as one place with
// three views (browse, search, open) rather than three pages sharing a URL
// prefix. This supersedes CL-4247, which had briefly promoted Skills and
// Agents to top-level Settings pages: architecture review rejected that
// (Settings means "configure the app"; these are working surfaces), so both
// the CL-4247 /settings/skills, /settings/skills/new, /settings/skills/:id,
// /settings/agents paths AND the original top-level /skills, /skills/new,
// /skills/:id, /agents, /artifacts, /artifacts/:id paths now redirect here,
// preserving id, query string, and hash.
function RedirectSkillsToLibrary() {
  const location = useLocation();
  return (
    <Navigate
      to={{
        pathname: "/library/skills",
        search: location.search,
        hash: location.hash,
      }}
      replace
    />
  );
}

function RedirectSkillsNewToLibrary() {
  const location = useLocation();
  return (
    <Navigate
      to={{
        pathname: "/library/skills/new",
        search: location.search,
        hash: location.hash,
      }}
      replace
    />
  );
}

function RedirectSkillDetailToLibrary() {
  const { id } = useParams();
  const location = useLocation();
  return (
    <Navigate
      to={{
        pathname: `/library/skills/${id ?? ""}`,
        search: location.search,
        hash: location.hash,
      }}
      replace
    />
  );
}

function RedirectAgentsToLibrary() {
  const location = useLocation();
  return (
    <Navigate
      to={{
        pathname: "/library/agents",
        search: location.search,
        hash: location.hash,
      }}
      replace
    />
  );
}

function RedirectArtifactsToLibrary() {
  const location = useLocation();
  return (
    <Navigate
      to={{
        pathname: "/library/artifacts",
        search: location.search,
        hash: location.hash,
      }}
      replace
    />
  );
}

function RedirectArtifactDetailToLibrary() {
  const { artifactId } = useParams();
  const location = useLocation();
  return (
    <Navigate
      to={{
        pathname: `/library/artifacts/${artifactId ?? ""}`,
        search: location.search,
        hash: location.hash,
      }}
      replace
    />
  );
}

// The standalone /admin and /owner surfaces (CL-3763) moved under /settings as
// role-gated management groups. These deep-link redirects preserve every old
// bookmark and sub-route by forwarding the matched wildcard tail verbatim —
// including further-nested legacy redirects (e.g. /owner/templates), which
// resolve once more against the routes registered under /settings/owner.
function RedirectAdminToSettings() {
  const location = useLocation();
  const { "*": rest } = useParams();
  return (
    <Navigate
      to={{
        pathname: mapLegacyAdminPath(rest),
        search: location.search,
        hash: location.hash,
      }}
      replace
    />
  );
}

function RedirectOwnerToSettings() {
  const location = useLocation();
  const { "*": rest } = useParams();
  return (
    <Navigate
      to={{
        pathname: mapLegacyOwnerPath(rest),
        search: location.search,
        hash: location.hash,
      }}
      replace
    />
  );
}

// Static navigation commands for the command palette, kept beside the route
// table so a new top-level route adds its palette entry in the same place. Each
// `to` must resolve to a path registered in the router below.
export const NAV_COMMANDS: PaletteResultItem[] = [
  {
    id: "nav:chats",
    category: "navigation",
    title: "Threads",
    to: "/chats",
    keywords: ["conversations", "myra", "messages", "chats"],
  },
  {
    id: "nav:inbox",
    category: "navigation",
    title: "Inbox",
    to: "/inbox",
    keywords: ["mail", "mailbox", "messages", "email", "notifications"],
  },
  {
    id: "nav:library",
    category: "navigation",
    title: "Library",
    to: "/library",
    keywords: ["artifacts", "skills", "agents", "collateral", "documents"],
  },
  {
    id: "nav:artifacts",
    category: "navigation",
    title: "Artifacts",
    to: "/library/artifacts",
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
    to: "/library/skills",
    keywords: ["playbooks", "prompts", "library"],
  },
  {
    id: "nav:tools",
    category: "navigation",
    title: "Tools",
    to: "/settings/admin/tools",
    keywords: ["integrations", "providers", "library", "admin", "settings"],
    requires: "admin",
  },
  {
    id: "nav:admin",
    category: "navigation",
    title: "Users & agents",
    to: "/settings/admin",
    keywords: [
      "governance",
      "grants",
      "roles",
      "principals",
      "audit",
      "admin",
      "settings",
    ],
    requires: "admin",
  },
  {
    id: "nav:owner",
    category: "navigation",
    title: "Workbench management",
    to: "/settings/owner",
    keywords: ["owner", "workbench", "settings"],
    requires: "owner",
  },
  {
    id: "nav:agents",
    category: "navigation",
    title: "Agents",
    to: "/library/agents",
    keywords: ["agents", "instances", "myra", "oat", "library"],
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
    keywords: ["preferences", "theme", "account", "connections", "oauth"],
  },
];

/** CL-3464: legacy top-level `/connections` → OAuth landing path. */
function RedirectLegacyConnections() {
  const location = useLocation();
  return (
    <Navigate
      to={{ pathname: "/settings/connections", search: location.search }}
      replace
    />
  );
}

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
              <PageChromeProvider>
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
                        <AppTopBar onOpenMenu={() => setDrawerOpen(true)} />
                        <main
                          data-tour="myra-chat"
                          className="flex-1 overflow-hidden"
                        >
                          <Outlet />
                        </main>
                        <PersonalAgentChat />
                      </div>
                      <WhatsNewPopup />
                    </div>
                  </OnboardingTourProvider>
                </ConnectionStatusProvider>
              </PageChromeProvider>
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
          {
            path: "/library",
            element: <LibraryLayout />,
            children: [
              {
                index: true,
                element: <Navigate to="/library/artifacts" replace />,
              },
              { path: "artifacts", element: <ArtifactsPage /> },
              {
                path: "artifacts/:artifactId",
                element: <ArtifactDetailPage />,
              },
              { path: "skills", element: <SkillsLibrary /> },
              { path: "skills/new", element: <SkillsNew /> },
              { path: "skills/:id", element: <SkillDetail /> },
              { path: "agents", element: <AgentsPage /> },
            ],
          },
          {
            path: "/workbenches/:slug",
            element: <Navigate to="/library/artifacts" replace />,
          },
          { path: "/workflows", element: <WorkflowsPage /> },
          { path: "/workflows/:workflowId", element: <WorkflowsPage /> },
          {
            path: "/routines",
            element: <RedirectRoutinesToWorkflows />,
          },
          {
            path: "/routines/:id",
            element: <RedirectRoutineDetailToWorkflows />,
          },
          {
            path: "/automations",
            element: <Navigate to="/workflows" replace />,
          },
          {
            path: "/settings",
            element: <SettingsLayout />,
            children: [
              { index: true, element: <Settings /> },
              { path: "connections", element: <Settings /> },
              {
                path: "admin/tools",
                element: (
                  <RequireAdmin>
                    <ToolsLibrary />
                  </RequireAdmin>
                ),
              },
              {
                path: "admin/tools/:name",
                element: (
                  <RequireAdmin>
                    <ToolDetail />
                  </RequireAdmin>
                ),
              },
              {
                path: "admin",
                element: <AdminLayout />,
                children: [
                  {
                    index: true,
                    element: (
                      <Navigate to="/settings/admin/principals" replace />
                    ),
                  },
                  { path: "principals", element: <AdminPrincipals /> },
                  { path: "principals/:id", element: <PrincipalDetail /> },
                  { path: "definitions", element: <AdminDefinitions /> },
                  { path: "definitions/:key", element: <DefinitionDetail /> },
                  { path: "audit", element: <AdminAudit /> },
                ],
              },
              {
                path: "owner",
                element: <OwnerLayout />,
                children: [
                  {
                    index: true,
                    element: <Navigate to="/settings/owner/catalog" replace />,
                  },
                  { path: "catalog", element: <OwnerCatalog /> },
                  { path: "capabilities", element: <OwnerCapabilities /> },
                  {
                    path: "capabilities/gamma",
                    element: <OwnerGammaTemplates />,
                  },
                  { path: "workflows", element: <OwnerWorkflows /> },
                  { path: "schedules", element: <OwnerSchedules /> },
                  { path: "work-units", element: <OwnerWorkUnits /> },
                  { path: "demos", element: <OwnerDemos /> },
                  { path: "members", element: <OwnerMembers /> },
                  // Legacy owner sub-routes → their new homes, still under
                  // Settings.
                  {
                    path: "templates",
                    element: (
                      <Navigate
                        to="/settings/owner/capabilities/gamma"
                        replace
                      />
                    ),
                  },
                  {
                    path: "models",
                    element: <Navigate to="/settings/owner/catalog" replace />,
                  },
                  {
                    path: "setup",
                    element: <Navigate to="/settings/owner/catalog" replace />,
                  },
                ],
              },
            ],
          },
          { path: "/connections", element: <RedirectLegacyConnections /> },
          { path: "/settings/tools/:id", element: <SettingsToolDetail /> },
          // Artifacts, Skills, and Agents (CL-4256) moved under the Library
          // top-level nav entry. Every earlier home for these three redirects
          // here, preserving id, query string, and hash: the original
          // top-level /artifacts and /artifacts/:id paths, the original
          // top-level /skills and /agents paths, and the CL-4247
          // /settings/skills and /settings/agents paths that briefly
          // superseded them.
          { path: "/artifacts", element: <RedirectArtifactsToLibrary /> },
          {
            path: "/artifacts/:artifactId",
            element: <RedirectArtifactDetailToLibrary />,
          },
          { path: "/skills", element: <RedirectSkillsToLibrary /> },
          { path: "/skills/new", element: <RedirectSkillsNewToLibrary /> },
          { path: "/skills/:id", element: <RedirectSkillDetailToLibrary /> },
          { path: "/agents", element: <RedirectAgentsToLibrary /> },
          {
            path: "/settings/skills",
            element: <RedirectSkillsToLibrary />,
          },
          {
            path: "/settings/skills/new",
            element: <RedirectSkillsNewToLibrary />,
          },
          {
            path: "/settings/skills/:id",
            element: <RedirectSkillDetailToLibrary />,
          },
          {
            path: "/settings/agents",
            element: <RedirectAgentsToLibrary />,
          },
          // Tools moved under Admin (CL-2719), then under Settings (CL-3763).
          // Old paths redirect.
          {
            path: "/tools",
            element: <Navigate to="/settings/admin/tools" replace />,
          },
          { path: "/tools/:name", element: <RedirectToAdminTool /> },
          // The standalone /admin and /owner areas (CL-2719/CL-2735) unified
          // into role-gated Settings management groups (CL-3763). Every
          // sub-route redirects to its new home under /settings.
          { path: "/admin", element: <RedirectAdminToSettings /> },
          { path: "/admin/*", element: <RedirectAdminToSettings /> },
          { path: "/owner", element: <RedirectOwnerToSettings /> },
          { path: "/owner/*", element: <RedirectOwnerToSettings /> },
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
