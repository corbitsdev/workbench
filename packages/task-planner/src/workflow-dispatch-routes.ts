// Gives a running workflow (Myra) a dispatch surface reachable via
// sidecar auth rather than a tenant-session — the execution half of
// `@corbits/task-dispatch-tools`' `dispatch_task` tool (`approval:
// "ask"`-gated the same way `@corbits/capability-tools`'
// `request_capability` is; see that package's `tool.ts`/`client.ts` for
// the precedent this route mirrors). Mounted OUTSIDE tenant-session
// middleware, at `/api/workflow-task-planner`, authenticated exactly
// the way `@corbits/agent-directory`'s `createWorkflowCapabilityRoutes`
// is: sidecar bearer token + `x-workflow-run-address` header, resolved
// to `{tenantId, principalId, runId}` by a `WorkflowRunAuthenticator`.
// Self-TENANT scoped: every write this route makes is scoped to the
// authenticated run's own tenant/principal, never a caller-supplied id.
//
// No `requireGrant` check here, deliberately: the tool's own `approval:
// "ask"` gate already put a human in front of every call before this
// route ever runs (the same reasoning
// `workflow-capability-routes.ts`'s file header gives for its own
// self-definition case) — a grant row would be redundant with, not
// additive to, that per-invocation human approval.
//
// Two dispatch paths, chosen by whether the caller already knows which
// agent should do the work:
//   - `agentDefinitionId` given (from a prior `list_agents`/
//     `create_agent` tool call): skip `runPlanner`'s LLM re-ask
//     entirely — build a `{use}` `TaskSpec` directly and hand it to
//     `spawnFromTaskSpec`. Confirmed safe by reading
//     `spawnFromTaskSpec`'s single-task (non-chain) branch
//     (`spawn.ts`'s `spawnSingleTaskFromTaskSpec`): the `{use}` arm
//     never reads `input.inventory` — inventory is exclusively a
//     `{create}`-arm concern (`resolveCredentialBindings`) — so this
//     path is safe to pass a minimal `EMPTY_INVENTORY` rather than
//     paying for a real `assembleInventory` call.
//   - `agentDefinitionId` omitted: the full `dispatchWithPlanner`
//     composition (`runPlanner` then `spawnFromTaskSpec`) — Myra's own
//     planner picks or creates an agent, same as a person's own "let
//     Myra choose" request through `./routes.ts`. Composed inline here
//     rather than importing `./index.ts`'s `dispatchWithPlanner`, to
//     avoid a circular import (`./index.ts` re-exports this module).
import { type } from "arktype";
import { Hono } from "hono";

import { getLogger } from "@intx/log";
import {
  FoldedRunFailedError,
  FoldedRunTimedOutError,
} from "@corbits/folded-run-one-shot";
import { SkillRegistryError } from "@corbits/skills";
import type { TaskRecord } from "@corbits/tasks";
import type {
  WorkflowCapabilityRunAuthenticator,
  WorkflowCapabilityRunScope,
} from "@corbits/agent-directory";
import type { ChatStore } from "@corbits/chat";

import {
  PlannerMyraUnavailableError,
  runPlanner,
  type PlannerRunDeps,
} from "./planner-run";
import {
  PlannerCreateBoundsViolationError,
  PlannerCredentialBindingUnavailableError,
  PlannerDefinitionGrantDeniedError,
  spawnFromTaskSpec,
  type SpawnDeps,
} from "./spawn";
import {
  PlannerReferenceOutOfInventoryError,
  PlannerReplyUnparseableError,
} from "./task-spec";
import type { PlannerInventory } from "./inventory";

const log = getLogger(["task-planner", "workflow-dispatch-routes"]);

/** Structurally identical to `WorkflowCapabilityRunScope` — reused by
 * type name only so this file reads in its own vocabulary; the two
 * packages deliberately share no runtime import beyond the type. */
export type WorkflowDispatchRunScope = WorkflowCapabilityRunScope;
export type WorkflowRunAuthenticator = WorkflowCapabilityRunAuthenticator;

export type WorkflowDispatchEnv = {
  Variables: {
    workflowDispatchScope: WorkflowDispatchRunScope & { address: string };
  };
};

/** The `{use}`-only arm of `spawnFromTaskSpec`'s `input.inventory` never
 * gets read (see the file-level "why" comment) — this is a real,
 * type-correct `PlannerInventory`, just an empty one, so nothing about
 * `spawnFromTaskSpec`'s own signature has to bend for this call site. */
const EMPTY_INVENTORY: PlannerInventory = {
  agents: [],
  toolPackages: [],
  skills: [],
  memoryAvailable: false,
  models: [],
};

const DISPATCH_TOOL_PLANNER_RUN_ID = "tool:dispatch_task";

function errorEnvelope(code: string, message: string) {
  return { error: { code, message } };
}

const DISPATCH_FAILED_MESSAGE =
  "That task couldn't be dispatched. Try rephrasing the outcome, or name the agent yourself.";

/** Every fail-closed error either dispatch path can throw — Myra
 * unresolvable, the run timing out or failing, an unparseable reply, an
 * out-of-inventory reference, a `{create}` plan that violated a
 * create-agent bound, a denied `workflow-definition:*` `create` grant,
 * or an unresolvable skill pin — reads as the same honest "couldn't
 * dispatch" 422, mirroring `./routes.ts`'s `isPlanningFailure` exactly
 * (this route composes the same two functions that error list was
 * written against). Anything else is a platform fault, re-thrown for
 * the host's own error handling. */
function isDispatchFailure(err: unknown): boolean {
  return (
    err instanceof PlannerMyraUnavailableError ||
    err instanceof FoldedRunTimedOutError ||
    err instanceof FoldedRunFailedError ||
    err instanceof PlannerReplyUnparseableError ||
    err instanceof PlannerReferenceOutOfInventoryError ||
    err instanceof PlannerCreateBoundsViolationError ||
    err instanceof PlannerCredentialBindingUnavailableError ||
    err instanceof PlannerDefinitionGrantDeniedError ||
    err instanceof SkillRegistryError
  );
}

const DispatchBody = type({
  outcome: "string > 0",
  "agentDefinitionId?": "string > 0",
});

export type CreateWorkflowDispatchRoutesDeps = {
  readonly authenticator: WorkflowRunAuthenticator;
  /**
   * Resolves the dispatching run's own workbench, so a task's completion
   * can post its result back into the workbench it was dispatched
   * from, not only the Inbox — see `@corbits/tasks`' orchestrator.
   * Only the one method `workflow-participant-routes.ts` already
   * depends on for the same "caller's own workbench" lookup.
   */
  readonly chatStore: Pick<ChatStore, "findWorkbenchByParticipantAddress">;
} & SpawnDeps &
  PlannerRunDeps;

async function dispatchTask(
  deps: CreateWorkflowDispatchRoutesDeps,
  input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly outcome: string;
    readonly agentDefinitionId?: string;
  },
): Promise<TaskRecord> {
  if (input.agentDefinitionId !== undefined) {
    return spawnFromTaskSpec(deps, {
      tenantId: input.tenantId,
      principalId: input.principalId,
      spec: {
        kind: "task",
        use: input.agentDefinitionId,
        refinedOutcome: input.outcome,
      },
      plannerRunId: DISPATCH_TOOL_PLANNER_RUN_ID,
      inventory: EMPTY_INVENTORY,
    });
  }

  const { spec, plannerRunId, inventory } = await runPlanner(deps, {
    tenantId: input.tenantId,
    principalId: input.principalId,
    outcome: input.outcome,
  });
  return spawnFromTaskSpec(deps, {
    tenantId: input.tenantId,
    principalId: input.principalId,
    spec,
    plannerRunId,
    inventory,
  });
}

export function createWorkflowDispatchRoutes(
  deps: CreateWorkflowDispatchRoutesDeps,
): Hono<WorkflowDispatchEnv> {
  const app = new Hono<WorkflowDispatchEnv>();

  app.use("*", async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const address = c.req.header("x-workflow-run-address") ?? "";
    const scope = await deps.authenticator.resolve(token, address);
    if (scope === null) {
      return c.json(
        errorEnvelope(
          "unauthorized",
          "Missing or unrecognized sidecar bearer token / run address",
        ),
        401,
      );
    }
    c.set("workflowDispatchScope", { ...scope, address });
    await next();
  });

  app.post("/dispatch", async (c) => {
    const body = DispatchBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        errorEnvelope(
          "bad_request",
          `This dispatch couldn't be read: ${body.summary}`,
        ),
        400,
      );
    }

    const scope = c.get("workflowDispatchScope");

    try {
      const task = await dispatchTask(deps, {
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        outcome: body.outcome,
        ...(body.agentDefinitionId !== undefined
          ? { agentDefinitionId: body.agentDefinitionId }
          : {}),
      });

      // Best-effort: a task this dispatch itself just launched must
      // never fail on the back of a workbench lookup — an unresolved
      // workbench simply leaves the task's completion to the Inbox/Myra
      // fallback, same as a task launched with no workbench context at
      // all.
      const originWorkbench = await deps.chatStore
        .findWorkbenchByParticipantAddress(scope.tenantId, scope.address)
        .catch(() => undefined);
      if (originWorkbench !== undefined) {
        await deps.store.recordWorkbench({
          tenantId: scope.tenantId,
          id: task.id,
          workbenchId: originWorkbench.workbenchId,
        });
      }

      return c.json({ taskId: task.id }, 201);
    } catch (err) {
      log.error`workflow task dispatch failed for tenant ${scope.tenantId}: ${
        err instanceof Error ? err.message : String(err)
      }`;
      if (isDispatchFailure(err)) {
        return c.json(
          errorEnvelope("dispatch_failed", DISPATCH_FAILED_MESSAGE),
          422,
        );
      }
      throw err;
    }
  });

  return app;
}
