// The Routines page's seam to stock workflow deployments: list, run-now,
// pause/resume. `@corbits/workflows`'s deleted `./schedule/scheduled-route.ts`
// (and the hub route it backed) is gone; this reads the stock deployments
// listing (`GET /workflows/deployments`) joined against the tenant's workflow
// assets (`GET /assets?kind=workflow`) for a display name, exactly the two
// stock reads `vendor/intx/hub-api/src/routes/workflows.ts` exposes.
//
// The `schedule` trigger is reserved on Interchange but unimplemented — no
// scheduler fires it — so this reads deployments as plain workflows, with
// no schedule concept. Run-now and pause/resume have
// no backing stock route either (`/deployments` is list/create only; no
// per-deployment PATCH or trigger route exists), so both stay rejected
// promises with a message naming the missing route, same pattern as before.

import { type } from "arktype";
import { useQuery } from "@tanstack/react-query";
import { WorkflowDeploymentResponse } from "@intx/types";
import type { APIQuery } from "@/lib/api-query";
import { ApiQueryError, UnauthenticatedError, toAPIQuery } from "@/lib/api-query";
import { isAgentDeploySourceAssetName } from "@/agent-deploy";
import { MYRA_SOURCE_CONFIG } from "@/myra-source";

export const ScheduledWorkflowDefinition = type({
  definitionId: "string",
  assetId: "string",
  name: "string",
  tenantId: "string",
  status: "'deployed' | 'stopped'",
  createdAt: "string",
  updatedAt: "string",
});

export type ScheduledWorkflowDefinition = typeof ScheduledWorkflowDefinition.infer;

const DeploymentsSchema = WorkflowDeploymentResponse.array();
const WorkflowAssetSchema = type({ id: "string", name: "string" });
const WorkflowAssetsSchema = WorkflowAssetSchema.array();

function deploymentsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/workflows/deployments`;
}

function workflowAssetsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/assets?kind=workflow&inherited=false`;
}

async function fetchJSON<T>(path: string, schema: (data: unknown) => T | type.errors): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (response.status === 401) throw new UnauthenticatedError();
  if (!response.ok) {
    throw new ApiQueryError(`The server answered ${response.status}.`, response.status, path);
  }
  const parsed = schema(await response.json());
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(`Unexpected response shape: ${parsed.summary}`, undefined, path);
  }
  return parsed;
}

/** Myra's own deploy source and every agent `agent-deploy.ts` created are
 * `workflow`-kind assets too, but they're chat partners, not workflows —
 * excluded by the same asset naming the chat/deploy pipeline already owns
 * (`MYRA_SOURCE_CONFIG.assetName`, `agent-<slug>-source`), so this list
 * never depends on runtime agent state to stay accurate. */
function isAgentAssetName(name: string): boolean {
  return name === MYRA_SOURCE_CONFIG.assetName || isAgentDeploySourceAssetName(name);
}

/** Every workflow deployment on this tenant, named from the backing
 * workflow asset. A deployment whose asset can't be resolved still lists,
 * under a placeholder name, rather than disappearing. */
export async function listScheduledWorkflows(
  tenantId: string,
): Promise<readonly ScheduledWorkflowDefinition[]> {
  const [deployments, assets] = await Promise.all([
    fetchJSON(deploymentsPath(tenantId), DeploymentsSchema),
    fetchJSON(workflowAssetsPath(tenantId), WorkflowAssetsSchema),
  ]);
  const nameByAssetId = new Map(assets.map((asset) => [asset.id, asset.name]));
  return deployments
    .filter((deployment) => {
      const name = nameByAssetId.get(deployment.definitionAssetId);
      return name === undefined || !isAgentAssetName(name);
    })
    .map((deployment) => ({
      definitionId: deployment.id,
      assetId: deployment.definitionAssetId,
      name: nameByAssetId.get(deployment.definitionAssetId) ?? "Untitled workflow",
      tenantId: deployment.tenantId,
      status: deployment.status === "deployed" ? "deployed" : "stopped",
      createdAt: deployment.createdAt,
      updatedAt: deployment.createdAt,
    }));
}

/** No stock route reruns a deployment on demand yet. */
export function runScheduledWorkflowNow(
  tenantId: string,
  definitionId: string,
): Promise<{ runId: string }> {
  return Promise.reject(
    new ApiQueryError(
      "Running a workflow now has no stock route yet.",
      undefined,
      `/api/tenants/${tenantId}/workflows/deployments/${encodeURIComponent(definitionId)}/run`,
    ),
  );
}

/** No stock route pauses or resumes a deployment yet. */
export function setScheduledWorkflowStatus(
  tenantId: string,
  definitionId: string,
  status: "deployed" | "stopped",
): Promise<{ readonly status: string }> {
  return Promise.reject(
    new ApiQueryError(
      status === "deployed"
        ? "Resuming a deployment has no stock route yet."
        : "Pausing a deployment has no stock route yet.",
      undefined,
      `/api/tenants/${tenantId}/workflows/deployments/${encodeURIComponent(definitionId)}`,
    ),
  );
}

/**
 * Tenant-scoped query via TanStack Query. Keys must be stable arrays that
 * already include the tenant id under the `["tenant", tenantId, ...]`
 * convention so a bench switch can `removeQueries` the whole prefix.
 * When `enabled` is false the previous result is not kept on screen — TQ
 * drops the active fetch and the adapter reports loading until re-enabled.
 */
export function useTenantQuery<T>(
  key: readonly unknown[],
  enabled: boolean,
  fetcher: () => Promise<T>,
  refetchInterval?: (data: T | undefined) => number | false,
): APIQuery<T> {
  const result = useQuery({
    queryKey: key,
    enabled,
    queryFn: async () => {
      try {
        return await fetcher();
      } catch (cause) {
        if (cause instanceof ApiQueryError && cause.status === 401) {
          throw new UnauthenticatedError();
        }
        throw cause;
      }
    },
    ...(refetchInterval !== undefined
      ? {
          refetchInterval: (query: { state: { data: T | undefined } }) =>
            refetchInterval(query.state.data),
        }
      : {}),
  });
  return toAPIQuery(result);
}
