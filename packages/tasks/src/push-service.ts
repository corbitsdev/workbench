import { getLogger } from "@intx/log";

import type { TaskAdapter, TaskAdapterExecutableOperation } from "./adapter";
import type { TaskPushStore } from "./store";

const log = getLogger(["tasks", "push-service"]);

export type ResolveAdapterCredential = (
  providerName: string,
  tenantId: string,
) => Promise<{ apiKey: string; baseURL: string } | null>;

export type ResolveAssignee = (
  ownerPrincipalId: string,
  adapterId: string,
) => Promise<string | null>;

export type TaskPushRequest = {
  taskId: string;
  adapterId: string;
  operation: TaskAdapterExecutableOperation;
  actorPrincipalId: string;
};

// The user-visible outcome vocabulary is deliberately two-valued: a push either
// linked ("synced") or is still sending ("pending"). Failures stay server-side
// (logs/Sentry) and read as pending — never as an error state.
export type TaskPushOutcome =
  | {
      status: "synced";
      externalId: string;
      externalUrl?: string;
      deduped: boolean;
    }
  | { status: "pending" };

export interface TaskPushService {
  pushTask(request: TaskPushRequest): Promise<TaskPushOutcome>;
}

export function createTaskPushService(deps: {
  store: TaskPushStore;
  resolveCredential: ResolveAdapterCredential;
  adapters: Record<string, TaskAdapter>;
  resolveAssignee?: ResolveAssignee;
}): TaskPushService {
  async function pushTask(request: TaskPushRequest): Promise<TaskPushOutcome> {
    const adapter = deps.adapters[request.adapterId];
    if (!adapter) {
      throw new Error(`Unknown task adapter: ${request.adapterId}`);
    }
    if (!adapter.operations.includes(request.operation)) {
      throw new Error(
        `Task adapter ${adapter.id} does not support operation: ${request.operation}`,
      );
    }

    const task = await deps.store.loadTask(request.taskId);
    if (!task) {
      throw new Error(`Task not found: ${request.taskId}`);
    }

    const ref = await deps.store.ensurePendingRef({
      taskId: request.taskId,
      adapterId: request.adapterId,
      actorPrincipalId: request.actorPrincipalId,
    });

    // Layer 1 of idempotency: the (task, adapter) ref row. A create against an
    // already-linked ref is a no-op returning the existing external object.
    if (
      request.operation === "create" &&
      ref.syncState === "synced" &&
      ref.externalId !== null
    ) {
      return {
        status: "synced",
        externalId: ref.externalId,
        ...(ref.externalUrl === null ? {} : { externalUrl: ref.externalUrl }),
        deduped: true,
      };
    }

    const credential = await deps.resolveCredential(
      adapter.providerName,
      task.tenantId,
    );
    if (credential === null) {
      log.warn("task push left pending: no credential for adapter provider", {
        taskId: request.taskId,
        adapterId: request.adapterId,
        providerName: adapter.providerName,
      });
      return { status: "pending" };
    }

    const assignee = deps.resolveAssignee
      ? await deps.resolveAssignee(task.ownerPrincipalId, adapter.id)
      : null;

    try {
      const result = await adapter.execute(
        request.operation,
        {
          task,
          externalRef:
            ref.externalId === null
              ? null
              : {
                  adapterId: ref.adapterId,
                  externalId: ref.externalId,
                  ...(ref.externalUrl === null
                    ? {}
                    : { externalUrl: ref.externalUrl }),
                  syncState: ref.syncState,
                },
          // Layer 2 of idempotency: the wire key the adapter forwards to the
          // downstream system's own dedupe (e.g. the attio_create_note marker).
          idempotencyKey: `task:${request.taskId}:${request.operation}`,
          actorPrincipalId: request.actorPrincipalId,
          assignee,
        },
        credential,
      );
      await deps.store.markRefSynced({
        refId: ref.id,
        externalId: result.externalId,
        externalUrl: result.externalUrl ?? null,
      });
      return {
        status: "synced",
        externalId: result.externalId,
        ...(result.externalUrl === undefined
          ? {}
          : { externalUrl: result.externalUrl }),
        deduped: result.deduped,
      };
    } catch (cause) {
      log.error("task push failed; ref left pending", {
        taskId: request.taskId,
        adapterId: request.adapterId,
        operation: request.operation,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return { status: "pending" };
    }
  }

  return { pushTask };
}
