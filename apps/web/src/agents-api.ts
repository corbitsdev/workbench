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
import { useEffect, useState } from "react";

import type { APIQuery } from "./api";

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
      `The hub answered ${response.status} for ${path}.`,
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
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
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
        ? `The hub answered ${response.status} for ${path}.`
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

/** The tenant's visible, enabled catalog models, for the create-agent
 * form's model picker. Never invented client-side — only what the
 * catalog actually resolves against at launch time. */
export function listCatalogModels(
  tenantId: string,
): Promise<readonly CatalogModel[]> {
  return getJSON(
    `/api/tenants/${tenantId}/models?limit=${PAGE_LIMIT}`,
    ModelsPage,
  ).then((page) => page.data.filter((model) => !model.disabled));
}

export type CreateAgentDefinitionInput = {
  readonly name: string;
  readonly handle: string;
  readonly description?: string;
  readonly systemPrompt: string;
  readonly model?: string;
};

export function createAgentDefinition(
  tenantId: string,
  input: CreateAgentDefinitionInput,
): Promise<AgentDefinition> {
  return postJSON(
    `/api/tenants/${tenantId}/agent-definitions`,
    WorkflowDefinitionResponse,
    input,
  );
}

export type AgentDirectoryData = {
  readonly tenantId: string;
  readonly definitions: readonly AgentDefinition[];
  readonly instances: readonly AgentInstance[];
  readonly models: readonly CatalogModel[];
};

/**
 * Loads a bench's full agent directory in one shot, re-fetching whenever
 * `tenantId` changes or `reloadKey` is bumped — the same "no push, refetch
 * on demand" convention `useAPIQuery` uses, so a freshly created
 * definition shows up the moment the create dialog closes.
 */
export function useAgentDirectory(
  tenantId: string | undefined,
  reloadKey: number,
): APIQuery<AgentDirectoryData> {
  const [state, setState] = useState<APIQuery<AgentDirectoryData>>({
    kind: "loading",
  });

  useEffect(() => {
    if (tenantId === undefined) return;
    let cancelled = false;
    setState({ kind: "loading" });
    Promise.all([
      listAgentDefinitions(tenantId),
      listAgentInstances(tenantId),
      listCatalogModels(tenantId),
    ])
      .then(([definitions, instances, models]) => {
        if (cancelled) return;
        setState({
          kind: "ready",
          data: { tenantId, definitions, instances, models },
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof AgentDirectoryError && cause.status === 401) {
          setState({ kind: "unauthenticated" });
          return;
        }
        setState({
          kind: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, reloadKey]);

  return state;
}
