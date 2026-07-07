import { useActiveWorkbench } from "../lib/active-workbench-context";
import { NoWorkbenchWelcomePage } from "../pages/NoWorkbenchWelcomePage";

export function RequireWorkbenchAccess({
  children,
}: {
  children: React.ReactNode;
}) {
  const { workbenches, loading } = useActiveWorkbench();

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-page text-sm text-text-2">
        Loading workbenches…
      </div>
    );
  }

  if (workbenches.length === 0) {
    return <NoWorkbenchWelcomePage />;
  }

  return children;
}
