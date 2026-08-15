// Turns a task's terminal run state into an Inbox delivery — built
// once by the host and subscribed for the process's lifetime,
// mirroring `@corbits/chat`'s `createChatOrchestrator`: it subscribes
// once to the sidecar's own `"agent.event"` stream (the single surface
// that carries every agent's events, task-launched or not) and filters
// to the runs `@corbits/tasks` itself launched by looking each
// address up in the task store.
//
// A task needs two things a chat reply doesn't: a definite terminal
// signal (success vs failure) and both halves — reply text and
// artifact chips — in one inbox item, not two separate mail sends.
// `connector.reply` alone can't tell "the agent replied" from "the
// agent is done" (a multi-turn agent can reply more than once before
// its run bracket closes), so this orchestrator keys off
// `message.run.ended` (the harness's own per-message run bracket close,
// `status: "completed" | "failed"`) for the terminal signal, and caches
// the most recent `connector.reply` content per address to attach to
// that terminal event. Artifact chips arrive on a third, independent
// channel — the event-collector's `onTurnFinalized` callback — the
// same one `@corbits/chat`'s `createArtifactDeliveryHandler` reads;
// the host wires this orchestrator's `handleFinalizedTurn` into that
// callback alongside chat's own handler (see apps/hub/src/index.ts).
import { and, eq } from "drizzle-orm";
import { findFoldedRunByAddress } from "@corbits/folded-runs";

import {
  persistedArtifactsForFinalizedTurn,
  type FinalizedTurnToolCall,
  type PersistedArtifact,
} from "@corbits/chat";
import {
  deliverTaskResultMail,
  type NotifyDeliveryDeps,
} from "@corbits/notify";
import type { DB } from "@intx/db";
import { workflowDefinition } from "@intx/db/schema";
import type { SidecarEventEmitter } from "@intx/hub-sessions";
import { getLogger } from "@intx/log";

import type { TaskStore } from "./store";

const log = getLogger(["tasks", "orchestrator"]);

export type TaskOrchestratorDeps = {
  db: DB["db"];
  store: TaskStore;
  events: SidecarEventEmitter;
  notify: NotifyDeliveryDeps;
  /** Bumps the idle-sleep lifecycle's activity clock — same optional
   * shape `@corbits/chat`'s orchestrator carries. */
  recordActivity?: (address: string) => void;
};

export type TaskOrchestrator = {
  /** Unsubscribes from the event stream. */
  dispose(): void;
  /** Wire this into the same `onTurnFinalized` callback
   * `createArtifactDeliveryHandler` reads — see the module doc above. */
  handleFinalizedTurn(
    agentAddress: string,
    turn: { toolCalls: FinalizedTurnToolCall[] },
  ): void;
};

function connectorReplyContent(event: unknown): string | undefined {
  if (
    typeof event !== "object" ||
    event === null ||
    (event as { type?: unknown }).type !== "connector.reply"
  ) {
    return undefined;
  }
  const content = (event as { data?: { content?: unknown } }).data?.content;
  return typeof content === "string" && content !== "" ? content : undefined;
}

function runEndedStatus(
  event: unknown,
):
  | { status: "completed" | "failed"; errorMessage: string | undefined }
  | undefined {
  if (
    typeof event !== "object" ||
    event === null ||
    (event as { type?: unknown }).type !== "message.run.ended"
  ) {
    return undefined;
  }
  const data = (
    event as { data?: { status?: unknown; error?: { message?: unknown } } }
  ).data;
  if (data?.status !== "completed" && data?.status !== "failed")
    return undefined;
  const errorMessage =
    typeof data.error?.message === "string" ? data.error.message : undefined;
  return { status: data.status, errorMessage };
}

async function resolveAgentName(
  db: DB["db"],
  tenantId: string,
  definitionId: string,
): Promise<string> {
  const row = await db.query.workflowDefinition.findFirst({
    where: and(
      eq(workflowDefinition.id, definitionId),
      eq(workflowDefinition.tenantId, tenantId),
    ),
  });
  return row?.name ?? definitionId;
}

function artifactsForNotification(
  persisted: readonly PersistedArtifact[],
): readonly { id: string; title: string }[] {
  return persisted.map((artifact) => ({
    id: artifact.id,
    title: artifact.title,
  }));
}

export function createTaskOrchestrator(
  deps: TaskOrchestratorDeps,
): TaskOrchestrator {
  const lastReplyByAddress = new Map<string, string>();
  const finalizedToolCallsByAddress = new Map<
    string,
    readonly FinalizedTurnToolCall[]
  >();

  async function deliverTerminalTask(
    agentAddress: string,
    status: "completed" | "failed",
    errorMessage: string | undefined,
  ): Promise<void> {
    const run = await findFoldedRunByAddress(deps.db, agentAddress);
    if (run === undefined || run.principalId === null) return;

    const record = await deps.store.getTaskByRunId(run.id);
    if (record === null || record.status !== "running") return;

    const toolCalls = finalizedToolCallsByAddress.get(agentAddress) ?? [];
    const artifacts = artifactsForNotification(
      persistedArtifactsForFinalizedTurn(toolCalls),
    );
    const replyText = lastReplyByAddress.get(agentAddress);
    lastReplyByAddress.delete(agentAddress);
    finalizedToolCallsByAddress.delete(agentAddress);

    const agentName = await resolveAgentName(
      deps.db,
      record.tenantId,
      record.definitionId,
    );
    const completedAt = new Date();
    const elapsedMs = completedAt.getTime() - record.createdAt.getTime();
    const taskStatus = status === "completed" ? "done" : "failed";

    const report = await deliverTaskResultMail(deps.notify, {
      kind: "task-result",
      tenantId: record.tenantId,
      taskId: record.id,
      runId: record.runId,
      agentName,
      status: taskStatus,
      ...(replyText !== undefined ? { replyText } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      elapsedMs,
      artifacts: [...artifacts],
      recipients: [
        { tenantId: record.tenantId, principalId: record.principalId },
      ],
      createdAt: completedAt.toISOString(),
    });

    await deps.store.completeTask({
      tenantId: record.tenantId,
      id: record.id,
      status: taskStatus,
      resultMailId: report.deliveredMailboxRowIds[0] ?? null,
      completedAt,
    });
  }

  const unsubscribe = deps.events.on(
    "agent.event",
    ({ agentAddress, event }) => {
      deps.recordActivity?.(agentAddress);

      const content = connectorReplyContent(event);
      if (content !== undefined) {
        lastReplyByAddress.set(agentAddress, content);
        return;
      }

      const ended = runEndedStatus(event);
      if (ended === undefined) return;

      void deliverTerminalTask(
        agentAddress,
        ended.status,
        ended.errorMessage,
      ).catch((cause: unknown) => {
        log.error`task orchestrator: failed to deliver ${agentAddress}'s task result: ${
          cause instanceof Error ? cause.message : String(cause)
        }`;
      });
    },
  );

  return {
    dispose() {
      unsubscribe();
    },
    handleFinalizedTurn(agentAddress, turn) {
      finalizedToolCallsByAddress.set(agentAddress, turn.toolCalls);
    },
  };
}
