// Onboarding flow has moved to the "New workbench" modal in WorkbenchHome.
// This file is kept as a shell to avoid breaking any deep links that may exist
// during the transition; it simply redirects to home.
import { Navigate } from 'react-router';

export function OnboardingPage() {
  return <Navigate to="/" replace />;
}
