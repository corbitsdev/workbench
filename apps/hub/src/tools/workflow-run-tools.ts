import type { AgentTool } from "@intx/agent";
import { getAncestorChain } from "@intx/db";
import type {
  RepoStore,
  SessionService,
  SidecarRouter,
} from "@workbench/hub-sessions";
import type { CryptoProvider } from "@intx/types/runtime";
import {
  WORKFLOW_LIST_KINDS_DEFINITION,
  WORKFLOW_LIST_RUNS_DEFINITION,
  WORKFLOW_SIGNAL_DEFINITION,
  WORKFLOW_START_DEFINITION,
} from "@workbench/tools-workflows";
import type { HubDb } from "../db";
import type {
  EnsureDeploymentRoutableFn,
  ProvisionRunDeploymentFn,
} from "../routes/workflow-runs";
import { listRunnableWorkflowKinds } from "../lib/workflow-run-gate";
import {
  resumeWorkflowRun,
  startWorkflowRun,
  type StartWorkflowRunDeps,
} from "../workflow-executor/run-exec";
import { describePendingGates } from "../workflow-executor/pending-gate-info";
import { listRunRecords, loadRunRecord } from "../workflow-executor/run-store";
import type { ContextToolEntry } from "../lib/tool-registry";

export type WorkflowRunToolsContext = {
  db: HubDb;
  tenantId: string;
  principalId: string;
  sessionService?: SessionService;
  sidecarRouter?: SidecarRouter;
  repoStore?: RepoStore;
  cryptoProvider?: CryptoProvider;
  deploymentDomain?: string;
  provisionRunDeployment?: ProvisionRunDeploymentFn;
  ensureDeploymentRoutable?: EnsureDeploymentRoutableFn;
  // Shared with the /workflow-exec routes so the `workflow_start` hub
  // tool gets the same kind-specific trigger-payload enrichment as every other
  // start door (trigger-payload-enrichment-registry.ts).
  resolveUserIdentity?: StartWorkflowRunDeps["resolveUserIdentity"];
};

// Resolve who the calling agent acts FOR and which conversation it speaks
// from: instance principal → agent instance → member_agent_instance mapping.
// The mapping's memberPrincipalId is the run owner (the same principal the
// /workflow-exec routes record via getRequestedUserContext), and the mapping
// id IS the Myra thread — the conversation id the web chat uses — so
// originConversationId is threaded without the model supplying it (CL-2677).
// Fails closed for non-member-owned instances (dispatched/admin agents):
// their owner is unknown, so no run may be started or listed on their behalf.
async function resolveCaller(
  db: HubDb,
  context: { tenantId: string; principalId: string },
): Promise<{ memberPrincipalId: string; conversationId: string }> {
  const instance = await db.query.agentInstance.findFirst({
    where: (i, { and, eq }) =>
      and(
        eq(i.tenantId, context.tenantId),
        eq(i.principalId, context.principalId),
      ),
  });
  if (!instance) {
    throw new Error(
      "workflow tools are only available to member-owned agent instances",
    );
  }
  const mapping = await db.query.memberAgentInstance.findFirst({
    where: (m, { and, eq }) =>
      and(eq(m.tenantId, context.tenantId), eq(m.instanceId, instance.id)),
  });
  if (!mapping) {
    throw new Error(
      "workflow tools are only available to member-owned agent instances",
    );
  }
  return {
    memberPrincipalId: mapping.memberPrincipalId,
    conversationId: mapping.id,
  };
}

function requireWorkflowDeps(context: WorkflowRunToolsContext): {
  sessionService: SessionService;
  sidecarRouter: SidecarRouter;
  repoStore: RepoStore;
  cryptoProvider: CryptoProvider;
  deploymentDomain: string;
  provisionRunDeployment: ProvisionRunDeploymentFn;
  ensureDeploymentRoutable: EnsureDeploymentRoutableFn;
  resolveUserIdentity: StartWorkflowRunDeps["resolveUserIdentity"];
} {
  const {
    sessionService,
    sidecarRouter,
    repoStore,
    cryptoProvider,
    deploymentDomain,
    provisionRunDeployment,
    ensureDeploymentRoutable,
    resolveUserIdentity,
  } = context;
  if (
    !sessionService ||
    !sidecarRouter ||
    !repoStore ||
    !cryptoProvider ||
    deploymentDomain === undefined ||
    !provisionRunDeployment ||
    !ensureDeploymentRoutable ||
    !resolveUserIdentity
  ) {
    throw new Error(
      "workflow tools are not wired: hub workflow services missing from tool context",
    );
  }
  return {
    sessionService,
    sidecarRouter,
    repoStore,
    cryptoProvider,
    deploymentDomain,
    provisionRunDeployment,
    ensureDeploymentRoutable,
    resolveUserIdentity,
  };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalObject(
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = args[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function createWorkflowRunTools(
  context: WorkflowRunToolsContext,
): AgentTool[] {
  return [
    {
      kind: "string",
      definition: WORKFLOW_LIST_KINDS_DEFINITION,
      handler: async () => {
        const chain = await getAncestorChain(context.db, context.tenantId);
        const kinds = await listRunnableWorkflowKinds(context.db, chain);
        return JSON.stringify({ kinds }, null, 2);
      },
    },
    {
      kind: "string",
      definition: WORKFLOW_START_DEFINITION,
      handler: async (args) => {
        const deps = requireWorkflowDeps(context);
        const kind = requireString(args, "kind");
        const input = optionalObject(args, "input");
        const caller = await resolveCaller(context.db, context);
        const chain = await getAncestorChain(context.db, context.tenantId);
        const result = await startWorkflowRun(
          {
            db: context.db,
            sessionService: deps.sessionService,
            cryptoProvider: deps.cryptoProvider,
            deploymentDomain: deps.deploymentDomain,
            provisionRunDeployment: deps.provisionRunDeployment,
            resolveUserIdentity: deps.resolveUserIdentity,
          },
          {
            kind,
            chain,
            principalId: caller.memberPrincipalId,
            input,
            originConversationId: caller.conversationId,
          },
        );
        if (!result.ok) throw new Error(result.error);
        if (result.backgroundTask !== undefined) {
          await result.backgroundTask;
        }
        const state =
          (await loadRunRecord(context.db, result.state.runId)) ?? result.state;
        return JSON.stringify(
          {
            runId: state.runId,
            kind: state.kind,
            status: state.status,
            originConversationId: state.originConversationId,
          },
          null,
          2,
        );
      },
    },
    {
      kind: "string",
      definition: WORKFLOW_LIST_RUNS_DEFINITION,
      handler: async (args) => {
        const caller = await resolveCaller(context.db, context);
        const chain = await getAncestorChain(context.db, context.tenantId);
        const kind =
          typeof args.kind === "string" && args.kind.trim() !== ""
            ? args.kind.trim()
            : undefined;
        const allConversations = args.allConversations === true;
        const rows = await listRunRecords(
          context.db,
          chain,
          caller.memberPrincipalId,
          kind,
          allConversations
            ? undefined
            : { originConversationId: caller.conversationId },
        );
        const runs = await Promise.all(
          rows.map(async (row) => {
            if (row.status !== "awaiting") {
              return { ...row, pendingGates: [] as const };
            }
            // Listing only needs the run's repo to fold its gate — not the full
            // start/resume wiring. Degrade to no gates rather than coupling the
            // list path to launch deps it never uses (or throwing when a run has
            // no deployment / the enrichment deps are absent).
            const record = await loadRunRecord(context.db, row.runId);
            if (
              record === null ||
              record.deploymentId === undefined ||
              record.deploymentId === null ||
              context.repoStore === undefined ||
              context.deploymentDomain === undefined
            ) {
              return { ...row, pendingGates: [] as const };
            }
            const pendingGates = await describePendingGates(
              {
                repoStore: context.repoStore,
                deploymentDomain: context.deploymentDomain,
              },
              {
                runId: record.runId,
                kind: record.kind,
                deploymentId: record.deploymentId,
              },
            );
            return { ...row, pendingGates };
          }),
        );
        return JSON.stringify({ runs }, null, 2);
      },
    },
    {
      kind: "string",
      definition: WORKFLOW_SIGNAL_DEFINITION,
      handler: async (args) => {
        const deps = requireWorkflowDeps(context);
        const runId = requireString(args, "runId");
        const signalName = requireString(args, "signalName");
        const payload = optionalObject(args, "payload");
        const caller = await resolveCaller(context.db, context);
        const chain = await getAncestorChain(context.db, context.tenantId);
        const result = await resumeWorkflowRun(
          {
            db: context.db,
            repoStore: deps.repoStore,
            sidecarRouter: deps.sidecarRouter,
            deploymentDomain: deps.deploymentDomain,
            ensureDeploymentRoutable: deps.ensureDeploymentRoutable,
          },
          {
            runId,
            chain,
            principalId: caller.memberPrincipalId,
            signalName,
            payload,
          },
        );
        if (!result.ok) {
          // A wrong signal name (409, not parked on it) or a malformed payload
          // (400) is recoverable: return the run's real pending gate(s) + their
          // expected payload so the agent retries correctly instead of guessing
          // (CL-2870). Other failures (not found / not owner / delivery) throw.
          if (result.status === 409 || result.status === 400) {
            const record = await loadRunRecord(context.db, runId);
            const pendingGates =
              record !== null &&
              record.deploymentId !== undefined &&
              record.deploymentId !== null
                ? await describePendingGates(
                    {
                      repoStore: deps.repoStore,
                      deploymentDomain: deps.deploymentDomain,
                    },
                    {
                      runId: record.runId,
                      kind: record.kind,
                      deploymentId: record.deploymentId,
                    },
                  )
                : [];
            return JSON.stringify(
              { ok: false, error: result.error, pendingGates },
              null,
              2,
            );
          }
          throw new Error(result.error);
        }
        return JSON.stringify(
          {
            runId: result.state.runId,
            kind: result.state.kind,
            status: result.state.status,
          },
          null,
          2,
        );
      },
    },
  ];
}

const WORKFLOW_WRITE_TOOLS = new Set(["workflow_start", "workflow_signal"]);

function entry(name: string): ContextToolEntry {
  const definitions = {
    workflow_list_kinds: WORKFLOW_LIST_KINDS_DEFINITION,
    workflow_start: WORKFLOW_START_DEFINITION,
    workflow_list_runs: WORKFLOW_LIST_RUNS_DEFINITION,
    workflow_signal: WORKFLOW_SIGNAL_DEFINITION,
  } as const;
  return {
    sideEffect: WORKFLOW_WRITE_TOOLS.has(name) ? "write" : "read",
    definition: definitions[name as keyof typeof definitions],
    createTools: (context) => createWorkflowRunTools(context),
  };
}

export const WORKFLOWS_HUB_TOOLS: Record<string, ContextToolEntry> = {
  workflow_list_kinds: entry("workflow_list_kinds"),
  workflow_start: entry("workflow_start"),
  workflow_list_runs: entry("workflow_list_runs"),
  workflow_signal: entry("workflow_signal"),
};
