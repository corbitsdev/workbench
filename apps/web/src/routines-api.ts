// The Routines page's seam to stock workflow deployments. See
// docs/routines-scheduling.md for the schedule join and why run-now/
// pause/resume stay rejected promises.

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
  /** The cron expression firing this deployment's live run, or null when no
   * `@corbits/cron` row is addressed at it. */
  schedule: "string | null",
});

export type ScheduledWorkflowDefinition = typeof ScheduledWorkflowDefinition.infer;

export const CronSchedule = type({
  id: "string",
  tenantId: "string",
  expression: "string",
  /** The targeted agent's workflow definition name — stable across
   * redeploys, unlike the run address the ticker resolves at fire time. */
  definitionName: "string",
  subject: "string",
  body: "string",
  lastFiredAt: "string | null",
  /** Set once when the target's deployment is gone; a stopped schedule
   * never fires again, and a later redeploy does not resume it. */
  stoppedAt: "string | null",
  stoppedReason: "string | null",
  createdAt: "string",
});

export type CronSchedule = typeof CronSchedule.infer;

const CronSchedulesResponse = type({ schedules: CronSchedule.array() });
const CreatedCronSchedule = type({ schedule: CronSchedule });

export type NewCronSchedule = {
  readonly expression: string;
  readonly definitionName: string;
  readonly subject: string;
  readonly body: string;
};

/** The mount's own rejection when nothing live carries the target's name —
 * a distinct type so the form can say so in the person's words. */
export class NoLiveDeploymentError extends Error {
  constructor() {
    super("That agent has no live deployment to schedule.");
    this.name = "NoLiveDeploymentError";
  }
}

export async function createCronSchedule(
  tenantId: string,
  input: NewCronSchedule,
): Promise<CronSchedule> {
  const path = cronPath(tenantId);
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });
  if (response.status === 401) throw new UnauthenticatedError();
  if (response.status === 400) {
    const body: unknown = await response.json().catch(() => undefined);
    const error = type({ error: "string" })(body);
    if (!(error instanceof type.errors) && error.error === "no_live_deployment") {
      throw new NoLiveDeploymentError();
    }
  }
  if (!response.ok) {
    throw new ApiQueryError(`The server answered ${response.status}.`, response.status, path);
  }
  const parsed = CreatedCronSchedule(await response.json());
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(`Unexpected response shape: ${parsed.summary}`, undefined, path);
  }
  return parsed.schedule;
}

export async function deleteCronSchedule(tenantId: string, id: string): Promise<void> {
  const path = `${cronPath(tenantId)}/${encodeURIComponent(id)}`;
  const response = await fetch(path, { method: "DELETE" });
  if (response.status === 401) throw new UnauthenticatedError();
  if (!response.ok) {
    throw new ApiQueryError(`The server answered ${response.status}.`, response.status, path);
  }
}

const DeploymentsSchema = WorkflowDeploymentResponse.array();
const WorkflowAssetSchema = type({ id: "string", name: "string" });
const WorkflowAssetsSchema = WorkflowAssetSchema.array();

function deploymentsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/workflows/deployments`;
}

function workflowAssetsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/assets?kind=workflow&inherited=false`;
}

function cronPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/cron`;
}

/** Every cron schedule saved on this tenant. */
export async function listCronSchedules(tenantId: string): Promise<readonly CronSchedule[]> {
  const parsed = await fetchJSON(cronPath(tenantId), CronSchedulesResponse);
  return parsed.schedules;
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

// Myra and every deployed agent are `workflow`-kind assets too, but they're
// chat partners, not workflows — excluded by name, not runtime state.
function isAgentAssetName(name: string): boolean {
  return name === MYRA_SOURCE_CONFIG.assetName || isAgentDeploySourceAssetName(name);
}

/** Every workflow deployment on this tenant, named from the backing
 * workflow asset. A deployment whose asset can't be resolved still lists,
 * under a placeholder name, rather than disappearing. */
export async function listScheduledWorkflows(
  tenantId: string,
): Promise<readonly ScheduledWorkflowDefinition[]> {
  const [deployments, assets, schedules] = await Promise.all([
    fetchJSON(deploymentsPath(tenantId), DeploymentsSchema),
    fetchJSON(workflowAssetsPath(tenantId), WorkflowAssetsSchema),
    listCronSchedules(tenantId),
  ]);
  const nameByAssetId = new Map(assets.map((asset) => [asset.id, asset.name]));
  // A schedule names its target by definition name, which is the source
  // asset's name — so a redeploy keeps the row joined to the same row here.
  const expressionByDefinitionName = new Map(
    schedules
      .filter((row) => row.stoppedAt === null)
      .map((row) => [row.definitionName, row.expression]),
  );
  return deployments
    .filter((deployment) => {
      const name = nameByAssetId.get(deployment.definitionAssetId);
      return name === undefined || !isAgentAssetName(name);
    })
    .map((deployment) => {
      const name = nameByAssetId.get(deployment.definitionAssetId);
      return {
        definitionId: deployment.id,
        assetId: deployment.definitionAssetId,
        name: name ?? "Untitled workflow",
        tenantId: deployment.tenantId,
        status: deployment.status === "deployed" ? "deployed" : "stopped",
        createdAt: deployment.createdAt,
        updatedAt: deployment.createdAt,
        schedule: name === undefined ? null : (expressionByDefinitionName.get(name) ?? null),
      };
    });
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

// Keys must be stable arrays under `["tenant", tenantId, ...]` so a bench
// switch can `removeQueries` the whole prefix.
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
