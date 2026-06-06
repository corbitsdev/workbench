import { createBrowserRouter, Navigate, Outlet } from 'react-router';
import { Suspense, lazy } from 'react';
import { useAuth } from './components/AuthProvider';
import { AppSidebar } from './components/layout/AppSidebar';
import { PersonalAgentChat } from './components/PersonalAgentChat';
import { ChatLauncherProvider } from './lib/chat-launcher-context';
import { LoginPage } from './pages/LoginPage';
import WorkbenchHome from './pages/WorkbenchHome';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import { OnboardingPage } from './pages/OnboardingPage';
const CredentialSettingsPage = lazy(() => import('./pages/CredentialSettingsPage'));
const TenantSettingsPage = lazy(() => import('./pages/TenantSettingsPage'));
const PrincipalSettingsPage = lazy(() => import('./pages/PrincipalSettingsPage'));

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
          { path: '/onboarding', element: <OnboardingPage /> },
          { index: true, element: <WorkbenchHome /> },
          { path: '/dashboard', element: <Dashboard /> },
          { path: '/settings', element: <Settings /> },
          {
            path: '/settings/credentials',
            element: (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <span className="text-[13px] text-text-3">Loading...</span>
                  </div>
                }
              >
                <CredentialSettingsPage />
              </Suspense>
            ),
          },
          {
            path: '/settings/tenants/:tenantId',
            element: (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <span className="text-[13px] text-text-3">Loading...</span>
                  </div>
                }
              >
                <TenantSettingsPage />
              </Suspense>
            ),
          },
          {
            path: '/settings/tenants/:tenantId/principals/:principalId',
            element: (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <span className="text-[13px] text-text-3">Loading...</span>
                  </div>
                }
              >
                <PrincipalSettingsPage />
              </Suspense>
            ),
          },
          { path: '/workbenches/:slug', element: <WorkbenchHome /> },
        ],
      },
    ],
  },
]);
