import { useNavigate, useParams } from "react-router";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ActiveWorkflowRuns } from "../components/ActiveWorkflowRuns";
import { WorkflowCatalog } from "../components/WorkflowCatalog";
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

  return (
    <div className="@container h-full overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-6 py-8">
        <div className="mb-6 flex items-baseline gap-3">
          <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-text">
            Workflows
          </h1>
        </div>
        <ActiveWorkflowRuns tenantId={activeTenantId} />
        <WorkflowCatalog
          tenantId={activeTenantId}
          onWorkflowStarted={(runId) => navigate(`/workflows/${runId}`)}
        />
      </div>
    </div>
  );
}
