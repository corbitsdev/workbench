import { createBrowserRouter, Navigate, Outlet } from 'react-router';
import { useAuth } from './components/AuthProvider';
import { AppSidebar } from './components/layout/AppSidebar';
import { PersonalAgentChat } from './components/PersonalAgentChat';
import { ChatLauncherProvider } from './lib/chat-launcher-context';
import { LoginPage } from './pages/LoginPage';
import WorkbenchHome from './pages/WorkbenchHome';
import Settings from './pages/Settings';
import { SkillsLibrary } from './pages/SkillsLibrary';
import { SkillsNew } from './pages/SkillsNew';
import { SkillDetail } from './pages/SkillDetail';

function ProtectedLayout() {
  const { session } = useAuth();

  if (session.status === 'unauthenticated') return <Navigate to="/login" replace />;
  if (session.status === 'loading') return null;
  return <Outlet />;
}

function AppShell() {
  return (
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
          { index: true, element: <WorkbenchHome /> },
          { path: '/onboarding', element: <Navigate to="/" replace /> },
          { path: '/dashboard', element: <Navigate to="/" replace /> },
          { path: '/settings', element: <Settings /> },
          { path: '/skills', element: <SkillsLibrary /> },
          { path: '/skills/new', element: <SkillsNew /> },
          { path: '/skills/:id', element: <SkillDetail /> },
          { path: '/workbenches/:slug', element: <WorkbenchHome /> },
        ],
      },
    ],
  },
]);
