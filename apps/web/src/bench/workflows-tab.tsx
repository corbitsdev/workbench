import { RunNowButton, Skeleton } from "@corbits/react-ui";
import { useQuery } from "@tanstack/react-query";

import { routineDetailPath, useRoutineActions } from "@/global-routines";
import { scheduleSentence } from "@/pages/routines-page";
import { describeApiError } from "@/lib/api-query";
import { FlowArrow } from "@/lib/icons";
import { Link } from "@/navigation";
import { WORKFLOWS_PATH_PREFIX } from "@/path-ids";
import { tenantKeys } from "@/query-client";
import { listScheduledWorkflows } from "@/routines-api";
import { benchLink } from "../shell/page-crumbs";

/** The workflows deployed in this bench with their schedule and state. */
export function WorkflowsTab({ workbenchTenantId }: { readonly workbenchTenantId: string }) {
  const actions = useRoutineActions();
  const flows = useQuery({
    queryKey: tenantKeys.routines(workbenchTenantId),
    queryFn: () => listScheduledWorkflows(workbenchTenantId),
  });
  const rows = flows.data ?? [];

  return (
    <section className="drawer-sec">
      <div className="drawer-sec-head">
        <h3>Scheduled here</h3>
        <Link to={benchLink(WORKFLOWS_PATH_PREFIX, workbenchTenantId)}>Open all</Link>
      </div>
      {flows.isLoading ? <Skeleton className="h-16 w-full" /> : null}
      {flows.isError ? (
        <p className="workbench-info-empty-note">
          {describeApiError(flows.error, "loading workflows")}
        </p>
      ) : null}
      {flows.isSuccess && rows.length === 0 ? (
        <p className="workbench-info-empty-note">No workflows deployed here yet.</p>
      ) : null}
      {rows.length > 0 ? (
        <div className="drawer-list">
          {rows.map((definition) => (
            <div key={definition.definitionId} className="drawer-li">
              <FlowArrow size={16} aria-hidden="true" />
              <Link to={routineDetailPath(definition.definitionId)} className="drawer-li-t">
                <b>{definition.name}</b>
                <span>{scheduleSentence(definition.schedule)}</span>
              </Link>
              {definition.status === "deployed" && !definition.scheduleEnabled ? (
                <span className="drawer-li-m">Paused</span>
              ) : null}
              {definition.status === "deployed" ? (
                <RunNowButton
                  variant="outline"
                  size="sm"
                  onRun={() =>
                    actions.runNow({
                      definition,
                      tenantId: workbenchTenantId,
                      tenantName: "",
                    })
                  }
                />
              ) : (
                <span className="drawer-li-m">Paused</span>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
