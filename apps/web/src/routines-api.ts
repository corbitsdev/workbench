// The Routines page's seam to authored workflow definitions that carry a
// ScheduleTrigger: list, run-now, and pause/resume. Pause/resume is the
// same agent-directory status PUT seed uses (`stopped` / `deployed`).
//
// CL-8160: the hub routes `listScheduledWorkflows` and
// `runScheduledWorkflowNow`/`listAvailableCatalogWorkflows` used to call
// (`@corbits/workflows`'s deleted `./schedule/scheduled-route.ts`) are
// gone. Owner ruling: schedule state derives from stock reads client-side
// or stays a package-internal pure function — no hub route. Stock's
// `GET /workflows/definitions` (`vendor/intx/hub-api`) exposes no wire
// projection, so there is no stock-derivable way to know which
// definitions carry a `ScheduleTrigger` or what its cron is, and
// `listAvailableCatalogWorkflows`'s connection-satisfaction read has no
// stock equivalent either. Both resolve to an empty list rather than
// fetch a route that no longer exists (same pattern as `tenantKeys`'
// `routineActivity` comment in `query-client.ts` for CL-8087's deleted
// `feed=fires` route): the Routines roster and Available section render
// their existing empty states until an upstream ask lands. See the
// CL-8160 PR for exactly what is missing.

import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { useQuery } from "@tanstack/react-query";
import type { APIQuery } from "@corbits/api-query";
import {
  ApiQueryError,
  UnauthenticatedError,
  toAPIQuery,
} from "@corbits/api-query";

import { setAgentDefinitionStatus } from "./agents-api";

export const ScheduledWorkflowDefinition = type({
  definitionId: "string",
  assetId: "string",
  name: "string",
  tenantId: "string",
  status: "'deployed' | 'stopped'",
  cron: "string",
  createdAt: "string",
  updatedAt: "string",
});

export type ScheduledWorkflowDefinition =
  typeof ScheduledWorkflowDefinition.infer;

const ScheduledWorkflowsResponse = type({
  items: ScheduledWorkflowDefinition.array(),
});

export const AvailableCatalogWorkflow = type({
  assetName: "string",
  displayName: "string",
  description: "string",
  requiredConnections: "string[]",
  missingConnections: "string[]",
  connectionsSatisfied: "boolean",
});

export type AvailableCatalogWorkflow = typeof AvailableCatalogWorkflow.infer;

const AvailableCatalogWorkflowsResponse = type({
  items: AvailableCatalogWorkflow.array(),
});

const RunNowResponse = type({ runId: "string" });

type Validator<T> = (data: unknown) => T | ArkErrors;

async function request<T>(
  path: string,
  schema: Validator<T>,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new ApiQueryError(
      cause instanceof Error ? cause.message : String(cause),
      undefined,
      path,
    );
  }
  if (response.status === 401) {
    throw new ApiQueryError("Not signed in.", 401, path);
  }
  if (!response.ok) {
    const detail = await response
      .json()
      .then(
        (body: { error?: { userMessage?: string } }) =>
          body.error?.userMessage ?? "",
      )
      .catch(() => "");
    throw new ApiQueryError(
      detail === "" ? `The server answered ${response.status}.` : detail,
      response.status,
      path,
    );
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(
      `Unexpected response shape: ${parsed.summary}`,
      undefined,
      path,
    );
  }
  return parsed;
}

/** CL-8160: no route exists at this path any more — kept as a documented
 * dead address, not a live fetch target, for any caller that still reads
 * it for logging/keys. */
export function scheduledWorkflowsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/workflows/scheduled`;
}

/** CL-8160: no route exists at this path any more — see the file header. */
export function availableCatalogWorkflowsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/workflows/available`;
}

/** CL-8160: always empty — see the file header for why there is no
 * stock-derivable replacement yet. */
export function listAvailableCatalogWorkflows(
  _tenantId: string,
): Promise<readonly AvailableCatalogWorkflow[]> {
  return Promise.resolve([]);
}

export function scheduledWorkflowRunPath(
  tenantId: string,
  definitionId: string,
): string {
  return `/api/tenants/${tenantId}/workflows/scheduled/${encodeURIComponent(definitionId)}/run`;
}

/** CL-8160: always empty — see the file header for why there is no
 * stock-derivable replacement yet. */
export function listScheduledWorkflows(
  _tenantId: string,
): Promise<readonly ScheduledWorkflowDefinition[]> {
  return Promise.resolve([]);
}

/** CL-8160: unreachable in practice — `listScheduledWorkflows` never
 * returns a row for `onRunNow` to be called with — kept only so
 * `useRoutineActions`' shape does not need to change too. Throws rather
 * than fetching a route that no longer exists. */
export function runScheduledWorkflowNow(
  _tenantId: string,
  _definitionId: string,
): Promise<{ runId: string }> {
  return Promise.reject(
    new ApiQueryError(
      "Scheduled run-now has no stock route yet (CL-8160).",
      undefined,
      scheduledWorkflowRunPath(_tenantId, _definitionId),
    ),
  );
}

export function setScheduledWorkflowStatus(
  tenantId: string,
  definitionId: string,
  status: "deployed" | "stopped",
): Promise<{ readonly status: string }> {
  return setAgentDefinitionStatus(tenantId, definitionId, status);
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
  });
  return toAPIQuery(result);
}
