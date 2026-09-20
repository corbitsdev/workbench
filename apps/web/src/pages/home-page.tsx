// Default land: `/` is a hop onto the person's last-visited workbench,
// or the new-workbench picker when no visit is on record. Home as a
// dashboard does not earn its keep — `/` only exists as this hop. The
// workbench listing carries no recency of its own, so array order is never
// treated as "most recent": an unrecorded or stale last id falls through
// to the picker instead of guessing.

import { Button, EmptyState, PageShell } from "@corbits/react-ui";
import { WarningCircle } from "@/lib/icons";
import { useQuery } from "@tanstack/react-query";

import { WorkbenchLoadingState } from "@/chat";
import { listWorkbenchTenants, workbenchesQueryKey } from "@/chat/workbench-tenants";

import { useBench } from "../bench-context";
import { readLastWorkbenchId } from "../last-workbench";
import { useNavigate } from "../navigation";
import { Redirect } from "../redirect";
import { NEW_WORKBENCH_PATH } from "../routes";
import { workbenchPath } from "../workbench-path";

export function HomeRoute() {
  const navigate = useNavigate();
  const { selectedTenantId, memberships } = useBench();
  const workbenches = useQuery({
    queryKey: workbenchesQueryKey(selectedTenantId ?? "", "workbench"),
    enabled: selectedTenantId !== null,
    queryFn: () => listWorkbenchTenants(selectedTenantId ?? ""),
  });

  if (memberships.kind === "error" || workbenches.isError) {
    const cause: unknown = workbenches.error;
    const message =
      memberships.kind === "error"
        ? memberships.message
        : cause instanceof Error
          ? cause.message
          : String(cause);
    return (
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<WarningCircle />}
          title="Couldn't load your workbenches"
          description={message}
          action={
            <Button variant="outline" onClick={() => navigate(NEW_WORKBENCH_PATH)}>
              Start a new workbench
            </Button>
          }
        />
      </PageShell>
    );
  }

  if (workbenches.data !== undefined) {
    const lastId = selectedTenantId === null ? null : readLastWorkbenchId(selectedTenantId);
    const lastStillThere =
      lastId !== null && workbenches.data.some((workbench) => workbench.id === lastId);
    const to = lastStillThere && lastId !== null ? workbenchPath(lastId) : NEW_WORKBENCH_PATH;
    return <Redirect to={to} from="/" navigate={navigate} />;
  }

  return (
    <div className="page-fill shell-route-loading">
      <WorkbenchLoadingState delayMs={0} />
    </div>
  );
}
