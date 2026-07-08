import { Link } from "react-router";
import { toHumanLabel } from "@workbench/ui";
import { useWorkflowRuns, type WorkflowRun } from "../hooks/use-workflow";
import { isRecordTerminal, type RunRecord } from "../lib/run-state-adapter";
import {
  formatRunWhen,
  statusLabel,
  statusTextClass,
} from "../lib/workflow-run-status";

/**
 * Live (non-terminal) runs surfaced above the Workflows catalog so in-flight
 * work — especially runs parked on a human gate — stays visible where users
 * launch it. Each entry opens the interactive run pane. Browsable history
 * (terminal runs, filters, archive) lives in Insights (`/insights/runs`).
 * The strip renders nothing until run data is present (which also covers
 * loading and error): the catalog below is the page's primary surface, and
 * an empty strip is the honest idle state.
 */
export function ActiveWorkflowRuns({ tenantId }: { tenantId?: string | null }) {
  const { data: runs } = useWorkflowRuns(tenantId);
  const activeRuns = (runs ?? []).filter(
    (run) => !isRecordTerminal(run.status as RunRecord["status"]),
  );
  if (activeRuns.length === 0) return null;

  return (
    <section aria-label="Active runs" className="mb-6 flex flex-col gap-2">
      <h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-text-3">
        Active runs
      </h2>
      <div className="flex flex-col gap-0.5">
        {activeRuns.map((run: WorkflowRun) => (
          <Link
            key={run.runId}
            to={`/workflows/${run.runId}`}
            className="group flex items-center gap-2.5 rounded-[9px] px-2.5 py-2 transition-colors hover:bg-row-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
          >
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-blue"
            />
            <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
              <span className="truncate text-[13px] font-medium text-text">
                {toHumanLabel(run.kind)}
              </span>
              <span className="flex shrink-0 items-baseline gap-2.5">
                <span className="text-[11px] tabular-nums text-text-3">
                  {formatRunWhen(run.createdAt)}
                </span>
                <span
                  className={`text-[11px] font-medium ${statusTextClass(run.status)}`}
                >
                  {statusLabel(run.status)}
                </span>
              </span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
