// The Agents page reads through `chat/threads-api.ts`'s `listChatAgents`;
// this file carries no roster/detail data model of its own.

import { WorkflowDefinitionResponse, WorkflowRunResponse, paginatedSchema } from "@intx/types";
import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiQueryError } from "@/lib/api-query";
import { deployAgentSource, type DeployedAgent, type NewAgentInput } from "./agent-deploy";
import { chatKeys, workbenchKeys } from "./chat-path";
import { tenantKeys } from "./query-client";

export type AgentDefinition = typeof WorkflowDefinitionResponse.infer;
export type AgentInstance = typeof WorkflowRunResponse.infer;

const DefinitionsPage = paginatedSchema(WorkflowDefinitionResponse);
const InstancesPage = paginatedSchema(WorkflowRunResponse);

// The REST pagination ceiling; a bench past this needs real pagination,
// not a raised limit here.
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

// Single-tenant (accepted loss): the native listing filters one tenant, so
// a workspace parent sees only its own runs, not its child workbenches'.
export function listTopLevelRuns(tenantId: string): Promise<readonly AgentInstance[]> {
  return getJSON(`/api/tenants/${tenantId}/workflows/runs?limit=${PAGE_LIMIT}`, InstancesPage).then(
    (page) => page.data,
  );
}

// Invalidates the bench's agent directory and chat-agent roster so both
// pick up the new deployment without a manual refetch.
export function useDeployAgentMutation(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: NewAgentInput): Promise<DeployedAgent> =>
      deployAgentSource({ tenantId, input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tenantKeys.agentDirectory(tenantId) });
      void queryClient.invalidateQueries({ queryKey: tenantKeys.visibleAgents(tenantId) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.agents(tenantId) });
      // A deploy from a workbench transcript adds a participant to that workbench.
      void queryClient.invalidateQueries({ queryKey: workbenchKeys.participants(tenantId) });
    },
  });
}
