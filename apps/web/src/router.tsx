import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router';
import { useEffect, useState } from 'react';
import { useAuth } from './components/AuthProvider';
import { getMyPrincipals } from './lib/hub-api';
import { AppSidebar } from './components/layout/AppSidebar';
import { PersonalAgentChat } from './components/PersonalAgentChat';
import { LoginPage } from './pages/LoginPage';
import { OnboardingPage } from './pages/OnboardingPage';
import WorkbenchHome from './pages/WorkbenchHome';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';

type WorkspaceStatus = 'loading' | 'present' | 'absent' | 'error';

function ProtectedLayout() {
  const { session } = useAuth();
  const [workspaceStatus, setWorkspaceStatus] = useState<WorkspaceStatus>('loading');

  useEffect(() => {
    if (session.status !== 'authenticated') return;

    // Dev mode: skip workspace check — hub-api auth is unavailable without real credentials.
    if (import.meta.env.DEV) {
      setWorkspaceStatus('present');
      return;
    }

    getMyPrincipals()
      .then((principals) => {
        setWorkspaceStatus(principals.length > 0 ? 'present' : 'absent');
      })
      .catch((err: unknown) => {
        // Only treat 404 as "no workspace" — other errors (500, network) show an error
        // state rather than redirecting to onboarding, which could cause duplicate tenants.
        const status = (err as { status?: number }).status;
        setWorkspaceStatus(status === 404 ? 'absent' : 'error');
      });
  }, [session.status]);

  if (session.status === 'unauthenticated') return <Navigate to="/login" replace />;
  if (session.status === 'loading' || workspaceStatus === 'loading') return null;
  if (workspaceStatus === 'error') {
    return (
      <div className="flex min-h-svh items-center justify-center bg-surface p-6">
        <p className="text-sm text-text-2">Unable to reach the server. Please refresh the page.</p>
      </div>
    );
  }
  const location = useLocation();
  if (workspaceStatus === 'absent' && location.pathname !== '/onboarding')
    return <Navigate to="/onboarding" replace />;
  return <Outlet />;
}

function AppShell() {
  return (
    <div className="flex h-screen flex-row bg-page">
      <AppSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <main className="flex-1 overflow-hidden">
          <Outlet />
        </main>
        <PersonalAgentChat />
      </div>
    </div>
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
        path: '/onboarding',
        element: <OnboardingPage />,
      },
      {
        element: <AppShell />,
        children: [
          { index: true, element: <WorkbenchHome /> },
          { path: '/dashboard', element: <Dashboard /> },
          { path: '/settings', element: <Settings /> },
        ],
      },
    ],
  },
]);
