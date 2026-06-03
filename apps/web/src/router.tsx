import { createBrowserRouter, Navigate, Outlet, useLocation, NavLink } from 'react-router';
import { useEffect, useState } from 'react';
import { useAuth } from './components/AuthProvider';
import { getMyPrincipals } from './lib/hub-api';
import { LoginPage } from './pages/LoginPage';
import { OnboardingPage } from './pages/OnboardingPage';
import Dashboard from './pages/Dashboard';
import LiveAnalysisReview from './pages/LiveAnalysisReview';
import CollateralReview from './pages/CollateralReview';
import CollateralImprovement from './pages/CollateralImprovement';
import FinalExport from './pages/FinalExport';

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
  if (workspaceStatus === 'absent' && location.pathname !== '/onboarding') return <Navigate to="/onboarding" replace />;
  return <Outlet />;
}

function AppShell() {
  const { session, signOut } = useAuth();
  const name = session.status === 'authenticated' ? session.user.name : '';
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="h-screen flex">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 bg-surface border-r border-border flex flex-col h-screen">
        {/* Wordmark */}
        <div className="px-4 py-5 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-[10px] bg-orange flex items-center justify-center shrink-0"
              style={{ boxShadow: '0 4px 14px rgba(233,132,40,0.45)' }}
            >
              <span className="text-white font-black text-sm font-mono">C</span>
            </div>
            <div className="min-w-0">
              <div className="text-[11px] font-bold tracking-widest uppercase text-text-3 leading-none">Corbits</div>
              <div className="text-sm font-bold tracking-tight text-text leading-tight truncate">GTM Workbench</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
          <NavLink
            to="/dashboard"
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-surface-2 text-text'
                  : 'text-text-2 hover:bg-surface-2 hover:text-text'
              }`
            }
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            Dashboard
          </NavLink>
        </nav>

        {/* User + sign out */}
        <div className="px-3 py-4 border-t border-border">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-7 h-7 rounded-full bg-blue flex items-center justify-center shrink-0">
              <span className="text-white text-[10px] font-bold font-mono">{initials}</span>
            </div>
            <span className="text-sm text-text-2 truncate min-w-0">{name}</span>
          </div>
          <button
            onClick={signOut}
            className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-text-3 hover:text-text hover:bg-surface-2 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 overflow-hidden">
        <Outlet />
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
          { index: true, element: <Navigate to="/dashboard" replace /> },
          { path: '/dashboard', element: <Dashboard /> },
          { path: '/workflows/:id/analyze', element: <LiveAnalysisReview /> },
          { path: '/workflows/:id/review', element: <CollateralReview /> },
          { path: '/workflows/:id/improvement', element: <CollateralImprovement /> },
          { path: '/workflows/:id/export', element: <FinalExport /> },
        ],
      },
    ],
  },
]);
