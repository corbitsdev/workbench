// The Agents page's one seam to the hub: agent definitions (templates
// an agent can be launched from), their deployed instances, and the
// tenant's model catalog — each fetched with the platform's own wire
// schemas, validated at the boundary exactly like every other query in
// `./api.ts`. Kept separate from that file because these three
// endpoints are tenant-scoped (the path needs a resolved `tenantId`
// before it can even be built), unlike the fixed `/api/me/...` paths
// `useAPIQuery` there is built around.

import {
  ModelResponse,
  RunApprovalsResponse,
  WorkflowDefinitionResponse,
  WorkflowRunHealth,
  WorkflowRunResponse,
  paginatedSchema,
} from "@intx/types";
import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { APIQuery } from "@/lib/api-query";
import { ApiQueryError, UnauthenticatedError, toAPIQuery } from "@/lib/api-query";
import { isChatPickerModelName } from "./settings/inference/model-capability";
import { deployAgentSource, type DeployedAgent, type NewAgentInput } from "./agent-deploy";
import { tenantKeys } from "./query-client";

export type AgentDefinition = typeof WorkflowDefinitionResponse.infer;
export type AgentInstance = typeof WorkflowRunResponse.infer;
export type CatalogModel = typeof ModelResponse.infer;

const DefinitionsPage = paginatedSchema(WorkflowDefinitionResponse);
const InstancesPage = paginatedSchema(WorkflowRunResponse);
const ModelsPage = paginatedSchema(ModelResponse);

// The REST pagination ceiling (see `vendor/intx/hub-api/src/pagination.ts`).
// A bench with more agents or instances than this needs real pagination on
// this page, not raised here — tracked as a known limit, not silently
// worked around.
const PAGE_LIMIT = 100;

type Validator<T> = (data: unknown) => T | ArkErrors;

async function getJSON<T>(path: string, schema: Validator<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { accept: "application/json" } });
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
    throw new ApiQueryError(`The server answered ${response.status}.`, response.status, path);
  }
  const parsed = schema(await response.json().catch(() => undefined));
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(`Unexpected response shape: ${parsed.summary}`, undefined, path);
  }
  return parsed;
}

export function listAgentDefinitions(tenantId: string): Promise<readonly AgentDefinition[]> {
  return getJSON(
    `/api/tenants/${tenantId}/workflows/definitions?limit=${PAGE_LIMIT}`,
    DefinitionsPage,
  ).then((page) => page.data);
}

export function listAgentInstances(tenantId: string): Promise<readonly AgentInstance[]> {
  return getJSON(`/api/tenants/${tenantId}/workflows/runs?limit=${PAGE_LIMIT}`, InstancesPage).then(
    (page) => page.data,
  );
}

/**
 * The tenant's genuine top-level deployment runs — every non-top-level
 * run (workbench host, invited agent, task) excluded server-side by the
 * native `GET /workflows/runs` listing's own predicate (`address IS NOT
 * NULL AND anchorRunId = id`), the same one `isTopLevelRun` uses. Used
 * wherever a page needs "real deployments only" — the Agent Directory.
 * Single-tenant (accepted loss): the deleted route expanded the
 * requested tenant to its whole descendant subtree via
 * `getDescendantTenants`; the native listing filters one tenant, so a
 * workspace parent sees only its own runs, not its child workbenches'.
 */
export function listTopLevelRuns(tenantId: string): Promise<readonly AgentInstance[]> {
  return getJSON(`/api/tenants/${tenantId}/workflows/runs?limit=${PAGE_LIMIT}`, InstancesPage).then(
    (page) => page.data,
  );
}

/** The tenant's visible, enabled catalog models for the create-agent form's
 * model picker. Uses `/catalog/models` (paginated `ModelResponse`), not the
 * bare-array discovery route at `/models` (`ModelInfo[]`) — those are
 * different wire shapes. Disabled rows are filtered out here because the
 * catalog may retain them. Embedding-named models, Hugging Face Hub paths,
 * and bare `.gguf` names are also omitted — this endpoint carries
 * no offering capability lists, so the name-only
 * {@link isChatPickerModelName} gate is the available signal. */
export function listCatalogModels(tenantId: string): Promise<readonly CatalogModel[]> {
  return getJSON(`/api/tenants/${tenantId}/catalog/models?limit=${PAGE_LIMIT}`, ModelsPage).then(
    (page) =>
      page.data.filter((model) => !model.disabled && isChatPickerModelName(model.canonicalName)),
  );
}

/** A single top-level run's own detail — `GET /workflows/runs/:runId`. For
 * a deployment's anchor run (which is what `AgentInstance` already lists),
 * this is the same record; fetched again here only right after a fresh
 * deploy, before the roster's own listing has picked it up. */
export function getAgentRun(tenantId: string, runId: string): Promise<AgentInstance> {
  return getJSON(
    `/api/tenants/${tenantId}/workflows/runs/${encodeURIComponent(runId)}`,
    WorkflowRunResponse,
  );
}

export type AgentRunHealth = typeof WorkflowRunHealth.infer;

/** `GET /workflows/runs/:runId/health` — liveness/readiness for a live run. */
export function getAgentRunHealth(tenantId: string, runId: string): Promise<AgentRunHealth> {
  return getJSON(
    `/api/tenants/${tenantId}/workflows/runs/${encodeURIComponent(runId)}/health`,
    WorkflowRunHealth,
  );
}

const RunEvent = type({ seq: "number", type: "string", body: "Record<string, unknown>" });
export type AgentRunEvent = typeof RunEvent.infer;
const RunEventsResponse = type({ runId: "string", events: RunEvent.array() });

/** `GET /workflows/runs/:runId/events` — the run's committed, seq-ordered
 * event log. */
export function getAgentRunEvents(
  tenantId: string,
  runId: string,
): Promise<readonly AgentRunEvent[]> {
  return getJSON(
    `/api/tenants/${tenantId}/workflows/runs/${encodeURIComponent(runId)}/events`,
    RunEventsResponse,
  ).then((page) => page.events);
}

export type AgentRunApprovals = typeof RunApprovalsResponse.infer;

/** `GET /workflows/runs/:runId/approvals` — the run's approval decisions,
 * newest first. */
export function getAgentRunApprovals(tenantId: string, runId: string): Promise<AgentRunApprovals> {
  return getJSON(
    `/api/tenants/${tenantId}/workflows/runs/${encodeURIComponent(runId)}/approvals`,
    RunApprovalsResponse,
  );
}

export type AgentDirectoryData = {
  readonly tenantId: string;
  readonly definitions: readonly AgentDefinition[];
  readonly instances: readonly AgentInstance[];
  readonly models: readonly CatalogModel[];
  /** Set when the model catalog failed independently; definitions and
   * instances still load so the page stays usable. */
  readonly modelsError?: string;
};

type ModelsOutcome =
  | { readonly ok: true; readonly models: readonly CatalogModel[] }
  | { readonly ok: false; readonly message: string };

/**
 * Loads a bench's agent directory. Definitions and instances are required;
 * the model catalog is best-effort so its failure alone never blanks the
 * page — surfaced as `modelsError` rather than a silent empty catalog.
 * `instances` comes from `listTopLevelRuns`, which already excludes every
 * non-top-level run (workbench host, invited agent) server-side — the
 * native `GET /workflows/runs` listing's own predicate — so this page
 * never has to derive that exclusion itself from a tenant's workbenches.
 */
export async function loadAgentDirectory(tenantId: string): Promise<AgentDirectoryData> {
  const [definitions, instances, modelsOutcome] = await Promise.all([
    listAgentDefinitions(tenantId),
    listTopLevelRuns(tenantId),
    listCatalogModels(tenantId).then(
      (models): ModelsOutcome => ({ ok: true, models }),
      (cause: unknown): ModelsOutcome => ({
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    ),
  ]);

  return {
    tenantId,
    definitions,
    instances,
    models: modelsOutcome.ok ? modelsOutcome.models : [],
    ...(modelsOutcome.ok ? {} : { modelsError: modelsOutcome.message }),
  };
}

/**
 * Loads a bench's full agent directory. One query owns definitions +
 * instances + models (models are best-effort inside `loadAgentDirectory`,
 * surfacing `modelsError`) so the page keeps a single loading/error
 * envelope. Pass no reloadKey — invalidate `tenantKeys.agentDirectory(tenantId)`
 * after create.
 */
export function useAgentDirectory(tenantId: string | undefined): APIQuery<AgentDirectoryData> {
  const result = useQuery({
    queryKey:
      tenantId === undefined
        ? (["tenant", "none", "agents", "directory"] as const)
        : tenantKeys.agentDirectory(tenantId),
    enabled: tenantId !== undefined,
    queryFn: async () => {
      if (tenantId === undefined) {
        throw new Error("tenantId required when agent directory is enabled");
      }
      try {
        return await loadAgentDirectory(tenantId);
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

/** A selected agent run's liveness/readiness, polled only while a detail
 * view has it open — `enabled` gates the fetch on a run actually existing. */
export function useAgentRunHealth(
  tenantId: string | null,
  runId: string | null,
): APIQuery<AgentRunHealth> {
  const result = useQuery({
    queryKey: ["agent-run-health", tenantId, runId] as const,
    enabled: tenantId !== null && runId !== null,
    queryFn: () => getAgentRunHealth(tenantId as string, runId as string),
  });
  return toAPIQuery(result);
}

/** A selected agent run's committed event log. */
export function useAgentRunEvents(
  tenantId: string | null,
  runId: string | null,
): APIQuery<readonly AgentRunEvent[]> {
  const result = useQuery({
    queryKey: ["agent-run-events", tenantId, runId] as const,
    enabled: tenantId !== null && runId !== null,
    queryFn: () => getAgentRunEvents(tenantId as string, runId as string),
  });
  return toAPIQuery(result);
}

/** A selected agent run's approval decisions, newest first. */
export function useAgentRunApprovals(
  tenantId: string | null,
  runId: string | null,
): APIQuery<AgentRunApprovals> {
  const result = useQuery({
    queryKey: ["agent-run-approvals", tenantId, runId] as const,
    enabled: tenantId !== null && runId !== null,
    queryFn: () => getAgentRunApprovals(tenantId as string, runId as string),
  });
  return toAPIQuery(result);
}

/**
 * Deploys a hand-authored agent through the stock workflow-deploy path
 * (`agent-deploy.ts`), then invalidates the bench's agent directory so the
 * roster picks up the new deployment without a manual refetch.
 */
export function useDeployAgentMutation(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: NewAgentInput): Promise<DeployedAgent> =>
      deployAgentSource({ tenantId, input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tenantKeys.agentDirectory(tenantId) });
    },
  });
}

// The guided capability-add surface: only what this tenant actually has.
const CapabilityInventoryWire = type({
  toolPackages: type({ name: "string" }).array(),
  skills: type({ name: "string" }).array(),
  models: type({ canonicalName: "string" }).array(),
});
export type CapabilityInventory = typeof CapabilityInventoryWire.infer;

export function listCapabilityInventory(tenantId: string): Promise<CapabilityInventory> {
  return getJSON(
    `/api/tenants/${tenantId}/agent-definitions/capabilities/inventory`,
    CapabilityInventoryWire,
  );
}
