import { createBrowserRouter, Navigate, Outlet } from 'react-router';
import { useAuth } from './components/AuthProvider';
import { LoginPage } from './pages/LoginPage';
import Dashboard from './pages/Dashboard';
import LiveAnalysisReview from './pages/LiveAnalysisReview';
import CollateralReview from './pages/CollateralReview';
import CollateralImprovement from './pages/CollateralImprovement';
import FinalExport from './pages/FinalExport';

function ProtectedLayout() {
  const { session } = useAuth();
  if (session.status === 'loading') return null;
  if (session.status === 'unauthenticated') return <Navigate to="/login" replace />;
  return <Outlet />;
}

function AppShell() {
  return (
    <div className="h-screen flex flex-col">
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
