import { useNavigate } from 'react-router';
import { StepSidebar as StatelessStepSidebar, type Step } from '@workbench/workflow';
import { useAuth } from './AuthProvider';

export type { Step };

interface StepSidebarProps {
  steps: Step[];
  sourceLabel?: string;
  selectionCount?: number;
}

/**
 * App-side wrapper that supplies router and auth wiring to the stateless
 * `@workbench/workflow` StepSidebar. The package component takes navigation
 * and auth as props/callbacks; this thin adapter binds them to react-router
 * and the AuthProvider.
 */
export default function StepSidebar(props: StepSidebarProps) {
  const { signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <StatelessStepSidebar
      {...props}
      onSignOut={async () => {
        await signOut();
        navigate('/login');
      }}
    />
  );
}
