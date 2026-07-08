import { useActiveWorkbench } from "../lib/active-workbench-context";
import { NoWorkbenchWelcomePage } from "../pages/NoWorkbenchWelcomePage";
import { WorkbenchLoadingScreen } from "./WorkbenchBootScreen";

export function RequireWorkbenchAccess({
  children,
}: {
  children: React.ReactNode;
}) {
  const { workbenches, loading } = useActiveWorkbench();

  if (loading) {
    return <WorkbenchLoadingScreen />;
  }

  if (workbenches.length === 0) {
    return <NoWorkbenchWelcomePage />;
  }

  return children;
}
