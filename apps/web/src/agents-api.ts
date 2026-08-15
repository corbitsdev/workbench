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
  WorkflowDefinitionResponse,
  WorkflowRunResponse,
  paginatedSchema,
} from "@intx/types";
import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { useQuery } from "@tanstack/react-query";
import { foldedRunIdsFromChannels, listAllChannels } from "@corbits/chat-ui";

import type { APIQuery } from "./api";
import { toAPIQuery } from "./api";
import { UnauthenticatedError, tenantKeys } from "./query-client";

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

export class AgentDirectoryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type Validator<T> = (data: unknown) => T | ArkErrors;

async function getJSON<T>(path: string, schema: Validator<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new AgentDirectoryError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (response.status === 401) {
    throw new AgentDirectoryError("Not signed in.", 401);
  }
  if (!response.ok) {
    throw new AgentDirectoryError(
      `The server answered ${response.status} for ${path}.`,
      response.status,
    );
  }
  const parsed = schema(await response.json().catch(() => undefined));
  if (parsed instanceof type.errors) {
    throw new AgentDirectoryError(
      `Unexpected response shape from ${path}: ${parsed.summary}`,
    );
  }
  return parsed;
}

const ErrorEnvelope = type({ error: { message: "string" } });

async function postJSON<T>(
  path: string,
  schema: Validator<T>,
  body: unknown,
  method: "POST" | "PUT" = "POST",
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new AgentDirectoryError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const envelope = ErrorEnvelope(json);
    const message =
      envelope instanceof type.errors
        ? `The server answered ${response.status} for ${path}.`
        : envelope.error.message;
    throw new AgentDirectoryError(message, response.status);
  }
  const parsed = schema(json);
  if (parsed instanceof type.errors) {
    throw new AgentDirectoryError(
      `Unexpected response shape from ${path}: ${parsed.summary}`,
    );
  }
  return parsed;
}

export function listAgentDefinitions(
  tenantId: string,
): Promise<readonly AgentDefinition[]> {
  return getJSON(
    `/api/tenants/${tenantId}/workflows/definitions?limit=${PAGE_LIMIT}`,
    DefinitionsPage,
  ).then((page) => page.data);
}

export function listAgentInstances(
  tenantId: string,
): Promise<readonly AgentInstance[]> {
  return getJSON(
    `/api/tenants/${tenantId}/workflows/runs?limit=${PAGE_LIMIT}`,
    InstancesPage,
  ).then((page) => page.data);
}

/** The tenant's visible, enabled catalog models for the create-agent form's
 * model picker. Uses `/catalog/models` (paginated `ModelResponse`), not the
 * bare-array discovery route at `/models` (`ModelInfo[]`) — those are
 * different wire shapes. Disabled rows are filtered out here because the
 * catalog may retain them. */
export function listCatalogModels(
  tenantId: string,
): Promise<readonly CatalogModel[]> {
  return getJSON(
    `/api/tenants/${tenantId}/catalog/models?limit=${PAGE_LIMIT}`,
    ModelsPage,
  ).then((page) => page.data.filter((model) => !model.disabled));
}

export type CreateAgentDefinitionInput = {
  readonly name: string;
  readonly handle: string;
  readonly description?: string;
  readonly systemPrompt: string;
  readonly model?: string;
  readonly skills?: readonly string[];
};

const CreatedAgentDefinition = WorkflowDefinitionResponse.and({
  skills: "string[]",
});

export function createAgentDefinition(
  tenantId: string,
  input: CreateAgentDefinitionInput,
): Promise<AgentDefinition & { readonly skills: readonly string[] }> {
  return postJSON(
    `/api/tenants/${tenantId}/agent-definitions`,
    CreatedAgentDefinition,
    input,
  );
}

const DefinitionSkillsMap = type({ skills: { "[string]": "string[]" } });

/** Every attached-skill list for the given definitions, keyed by definition
 * id. Best-effort at the call site — a bench with no skills backed asset
 * yet just gets `[]` for everything, never an error that blanks the page. */
export function listAgentSkills(
  tenantId: string,
  definitionIds: readonly string[],
): Promise<Record<string, readonly string[]>> {
  if (definitionIds.length === 0) return Promise.resolve({});
  const ids = encodeURIComponent(definitionIds.join(","));
  return getJSON(
    `/api/tenants/${tenantId}/agent-definitions/skills?ids=${ids}`,
    DefinitionSkillsMap,
  ).then((page) => page.skills);
}

/** Replaces one definition's attached skills wholesale — an empty array
 * detaches every skill, never a partial patch. */
export function updateAgentSkills(
  tenantId: string,
  definitionId: string,
  skills: readonly string[],
): Promise<readonly string[]> {
  return postJSON(
    `/api/tenants/${tenantId}/agent-definitions/${encodeURIComponent(definitionId)}/skills`,
    type({ skills: "string[]" }),
    { skills },
    "PUT",
  ).then((body) => body.skills);
}

export type AgentDirectoryData = {
  readonly tenantId: string;
  readonly definitions: readonly AgentDefinition[];
  readonly instances: readonly AgentInstance[];
  readonly models: readonly CatalogModel[];
  /** Attached skills per definition id. Missing entries read as "none". */
  readonly definitionSkills: Record<string, readonly string[]>;
  /** Every folded/chat workflowRun id (channel hosts + invited agents)
   * this tenant holds — see `foldedRunIdsFromChannels`. Fed to
   * `purposeAgentInstances` so an invited agent's chat run, which now
   * self-anchors like a real deployment, doesn't leak into the
   * directory as if it were one. */
  readonly foldedRunIds: ReadonlySet<string>;
  /** Set when the model catalog failed independently; definitions and
   * instances still load so the page stays usable. */
  readonly modelsError?: string;
};

type ModelsOutcome =
  | { readonly ok: true; readonly models: readonly CatalogModel[] }
  | { readonly ok: false; readonly message: string };

/**
 * Loads a bench's agent directory. Definitions and instances are required;
 * the model catalog and each definition's attached skills are best-effort
 * so either failing alone never blanks the page. The folded-run-id set is
 * required too, not best-effort like the model catalog: dropping it
 * silently on a transient failure would let invited-agent chat runs leak
 * back into the directory as if they were real deployments — exactly the
 * bug this filter exists to close (see `purposeAgentInstances` in
 * `agents-directory.ts`) — so a failure here fails the whole load instead.
 */
export async function loadAgentDirectory(
  tenantId: string,
): Promise<AgentDirectoryData> {
  const [definitions, instances, foldedRunIds, modelsOutcome] =
    await Promise.all([
      listAgentDefinitions(tenantId),
      listAgentInstances(tenantId),
      listAllChannels(tenantId).then(foldedRunIdsFromChannels),
      listCatalogModels(tenantId).then(
        (models): ModelsOutcome => ({ ok: true, models }),
        (cause: unknown): ModelsOutcome => ({
          ok: false,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
    ]);

  const definitionSkills = await listAgentSkills(
    tenantId,
    definitions.map((definition) => definition.id),
  ).catch(() => ({}) as Record<string, readonly string[]>);

  if (modelsOutcome.ok) {
    return {
      tenantId,
      definitions,
      instances,
      models: modelsOutcome.models,
      definitionSkills,
      foldedRunIds,
    };
  }
  return {
    tenantId,
    definitions,
    instances,
    models: [],
    definitionSkills,
    foldedRunIds,
    modelsError: modelsOutcome.message,
  };
}

/**
 * Loads a bench's full agent directory. One query owns definitions +
 * instances + models (models are best-effort inside `loadAgentDirectory`) so
 * the page keeps a single loading/error envelope. Pass no reloadKey —
 * invalidate `tenantKeys.agentDirectory(tenantId)` after create.
 */
export function useAgentDirectory(
  tenantId: string | undefined,
): APIQuery<AgentDirectoryData> {
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
        if (cause instanceof AgentDirectoryError && cause.status === 401) {
          throw new UnauthenticatedError();
        }
        throw cause;
      }
    },
  });
  return toAPIQuery(result);
}
