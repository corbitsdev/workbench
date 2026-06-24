import { createBrowserRouter, Navigate, Outlet } from 'react-router';
import { useAuth } from './components/AuthProvider';
import { AppSidebar } from './components/layout/AppSidebar';
import { PersonalAgentChat } from './components/PersonalAgentChat';
import { ChatLauncherProvider } from './lib/chat-launcher-context';
import { ActiveWorkbenchProvider } from './lib/active-workbench-context';
import { LoginPage } from './pages/LoginPage';
import { ChatThreadPage } from './pages/ChatThreadPage';
import { ArtifactsPage } from './pages/ArtifactsPage';
import { WorkflowsPage } from './pages/WorkflowsPage';
import Settings from './pages/Settings';
import { SkillsLibrary } from './pages/SkillsLibrary';
import { SkillsNew } from './pages/SkillsNew';
import { SkillDetail } from './pages/SkillDetail';
import { InsightsDashboard } from './pages/InsightsDashboard';

function ProtectedLayout() {
  const { session } = useAuth();

  if (session.status === 'unauthenticated') return <Navigate to="/login" replace />;
  if (session.status === 'loading') return null;
  return <Outlet />;
}

function AppShell() {
  return (
    <ActiveWorkbenchProvider>
      <ChatLauncherProvider>
        <div className="flex h-screen flex-row bg-page">
          <AppSidebar />
          <div className="flex flex-1 flex-col overflow-hidden">
            <main className="flex-1 overflow-hidden">
              <Outlet />
            </main>
            <PersonalAgentChat />
          </div>
        </div>
      </ChatLauncherProvider>
    </ActiveWorkbenchProvider>
  );
}

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    element: <ProtectedLayout />,
    children: [
      {
        element: <AppShell />,
        children: [
          // Chat-first: the index and /chats redirect to the last-active thread.
          { index: true, element: <ChatThreadPage /> },
          { path: '/chats', element: <ChatThreadPage /> },
          { path: '/chats/:threadId', element: <ChatThreadPage /> },
          { path: '/onboarding', element: <Navigate to="/" replace /> },
          { path: '/dashboard', element: <Navigate to="/" replace /> },
          { path: '/artifacts', element: <ArtifactsPage /> },
          { path: '/workbenches/:slug', element: <Navigate to="/artifacts" replace /> },
          { path: '/workflows', element: <WorkflowsPage /> },
          { path: '/settings', element: <Settings /> },
          { path: '/skills', element: <SkillsLibrary /> },
          { path: '/skills/new', element: <SkillsNew /> },
          { path: '/skills/:id', element: <SkillDetail /> },
          { path: '/insights', element: <InsightsDashboard /> },
        ],
      },
    ],
  },
]);
