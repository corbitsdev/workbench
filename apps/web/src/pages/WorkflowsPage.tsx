import { useMemo } from "react";
import { useNavigate, useParams } from "react-router";
import { AppPageChromeRow } from "@workbench/ui";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { useSetPageChrome } from "../lib/page-chrome";
import { ActiveWorkflowRuns } from "../components/ActiveWorkflowRuns";
import { WorkflowCatalog } from "../components/WorkflowCatalog";
import { MySchedules } from "../components/MySchedules";
import { WorkflowRunPane } from "../components/WorkflowRunPane";
import { useActiveWorkbench } from "../lib/active-workbench-context";

/**
 * The Workflows page is the launch catalog plus the user's live runs.
 * `/workflows` lists active (non-terminal) runs above a two-pane browse +
 * animated step preview; starting or opening a run shows its interactive
 * detail at `/workflows/:workflowId` so its human gates can be completed.
 * Browsable run history lives in Insights (`/insights/runs`), not here.
 */
export function WorkflowsPage() {
  const { workflowId } = useParams<{ workflowId?: string }>();
  const navigate = useNavigate();
  const { activeTenantId } = useActiveWorkbench();
  const selectedRunId = workflowId ?? null;

  if (selectedRunId !== null) {
    return (
      <div className="h-full min-h-0 overflow-hidden">
        <ErrorBoundary>
          <WorkflowRunPane
            deploymentId={selectedRunId}
            tenantId={activeTenantId}
            onClose={() => navigate("/workflows", { replace: true })}
          />
        </ErrorBoundary>
      </div>
    );
  }

  return <WorkflowsCatalog tenantId={activeTenantId} navigate={navigate} />;
}

function WorkflowsCatalog({
  tenantId,
  navigate,
}: {
  tenantId: string | null | undefined;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const pageChrome = useMemo(
    () => (
      <AppPageChromeRow
        title="Workflows"
        titleSize="sm"
        className="[&_h1]:text-[20px] [&_h1]:tracking-[-0.01em]"
      />
    ),
    [],
  );
  useSetPageChrome(pageChrome);

  const scopedTenantId = tenantId ?? null;

  return (
    <div className="@container h-full overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-6 py-8">
        <ActiveWorkflowRuns tenantId={scopedTenantId} />
        <WorkflowCatalog
          tenantId={scopedTenantId}
          onWorkflowStarted={(runId) => navigate(`/workflows/${runId}`)}
        />
        <ErrorBoundary>
          <MySchedules tenantId={scopedTenantId} />
        </ErrorBoundary>
      </div>
    </div>
  );
}
