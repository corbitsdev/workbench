// The hub seams this app still needs for agents: definitions (for the
// sidebar's own-agent-DM listing in `shell/bench-activity.ts`), top-level
// runs (for `chat/threads-api.ts`'s live-address resolution), and the
// create-agent deploy mutation. The Agents page itself now reads through
// `chat/threads-api.ts`'s `listChatAgents` — the same chat-partner listing
// — so this file no longer carries a roster/detail data model of its own.

import { WorkflowDefinitionResponse, WorkflowRunResponse, paginatedSchema } from "@intx/types";
import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiQueryError } from "@/lib/api-query";
import { deployAgentSource, type DeployedAgent, type NewAgentInput } from "./agent-deploy";
import { chatKeys, roomKeys } from "./chat-path";
import { tenantKeys } from "./query-client";

export type AgentDefinition = typeof WorkflowDefinitionResponse.infer;
export type AgentInstance = typeof WorkflowRunResponse.infer;

const DefinitionsPage = paginatedSchema(WorkflowDefinitionResponse);
const InstancesPage = paginatedSchema(WorkflowRunResponse);

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

/**
 * The tenant's genuine top-level deployment runs — every non-top-level
 * run (workbench host, invited agent, task) excluded server-side by the
 * native `GET /workflows/runs` listing's own predicate (`address IS NOT
 * NULL AND anchorRunId = id`), the same one `isTopLevelRun` uses.
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

/**
 * Deploys a hand-authored agent through the stock workflow-deploy path
 * (`agent-deploy.ts`), then invalidates the bench's agent directory and
 * chat-agent roster so both pick up the new deployment without a manual
 * refetch.
 */
export function useDeployAgentMutation(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: NewAgentInput): Promise<DeployedAgent> =>
      deployAgentSource({ tenantId, input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tenantKeys.agentDirectory(tenantId) });
      void queryClient.invalidateQueries({ queryKey: tenantKeys.visibleAgents(tenantId) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.agents(tenantId) });
      // A deploy from a room transcript adds a participant to that room.
      void queryClient.invalidateQueries({ queryKey: roomKeys.participants(tenantId) });
    },
  });
}
