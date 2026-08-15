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
import {
  connectorReplyContent,
  findFoldedRunByAddress,
  messageRunEnded,
} from "@corbits/folded-runs";
import {
  persistedArtifactsForFinalizedTurn,
  type FinalizedTurnToolCall,
  type PersistedArtifact,
} from "@corbits/turn-artifacts";
import {
  deliverTaskResultMail,
  type NotifyDeliveryDeps,
} from "@corbits/notify";
import type { DB } from "@intx/db";
import { workflowDefinition } from "@intx/db/schema";
import type { SidecarEventEmitter } from "@intx/hub-sessions";
import { getLogger } from "@intx/log";

import { advanceChain, type ChainDeps } from "./chain";
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
  /**
   * Launches the next leg of a chained task. Required: a host that
   * couldn't hand work on would strand every multi-agent task at its
   * first leg while reporting it finished.
   */
  launchLeg: ChainDeps["launchLeg"];
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
  // Synchronous claim against a redelivered terminal event (sidecar
  // reconnect replaying the frame, two frames landing on one tick) —
  // the same add-before-any-await shape `chat-orchestrator.ts`'s
  // `postApproveBlock` uses for its approval ids. Keyed by the agent's
  // address, the one identity the event carries synchronously; an
  // address maps 1:1 onto its folded run (`workflowRun.address` is the
  // run's own column), so this is a per-run claim. The claim releases
  // on "not a task after all" and on a failed delivery (so a genuine
  // redelivery can retry), and holds forever on success — the
  // conditional `completeTask` below is the durable guard; this set
  // only closes the in-flight race the store can't see.
  const claimedAddresses = new Set<string>();

  async function completeAndDeliver(
    agentAddress: string,
    record: {
      id: string;
      tenantId: string;
      principalId: string;
      definitionId: string;
      createdAt: Date;
    },
    taskStatus: "done" | "failed",
    errorMessage: string | undefined,
  ): Promise<void> {
    const completedAt = new Date();
    // Flip status FIRST, conditionally on still being "running" — the
    // store-level winner-takes-all guard (an UPDATE ... WHERE
    // status='running' in the drizzle store). Only the caller that won
    // the flip delivers mail, so a redelivered terminal event that
    // slipped past the in-memory claim (a second hub process, a claim
    // released by an earlier transient failure) can never double-mail.
    const completed = await deps.store.completeTask({
      tenantId: record.tenantId,
      id: record.id,
      status: taskStatus,
      completedAt,
    });
    if (completed === null) return;

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
    const elapsedMs = completedAt.getTime() - record.createdAt.getTime();

    const report = await deliverTaskResultMail(deps.notify, {
      kind: "task-result",
      tenantId: record.tenantId,
      taskId: record.id,
      runIds: [...completed.runIds],
      stepCount: completed.stepCount,
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

    const mailId = report.deliveredMailboxRowIds[0];
    if (mailId !== undefined) {
      await deps.store.recordResultMail({
        tenantId: record.tenantId,
        id: record.id,
        resultMailId: mailId,
      });
    }
  }

  async function deliverTerminalTask(
    agentAddress: string,
    status: "completed" | "failed",
    errorMessage: string | undefined,
  ): Promise<void> {
    const run = await findFoldedRunByAddress(deps.db, agentAddress);
    if (run === undefined || run.principalId === null) {
      claimedAddresses.delete(agentAddress);
      return;
    }

    const leg = await deps.store.getLegByRunId(run.id);
    if (leg === null) {
      claimedAddresses.delete(agentAddress);
      return;
    }
    const record = await deps.store.getTask(leg.tenantId, leg.taskId);
    if (record === null) {
      claimedAddresses.delete(agentAddress);
      return;
    }

    // Settle THIS leg before anything else, conditionally on it still
    // being "running" — the same winner-takes-all shape the task's own
    // terminal flip uses, applied once per leg rather than once per
    // task, so a chain's every hand-off is protected against a
    // redelivered terminal event, not just its last one.
    const settledAt = new Date();
    const legStatus = status === "completed" ? "done" : "failed";
    const settledLeg = await deps.store.settleLeg({
      tenantId: leg.tenantId,
      legId: leg.id,
      status: legStatus,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      settledAt,
    });
    if (settledLeg === null) return;

    if (legStatus === "failed") {
      await completeAndDeliver(agentAddress, record, "failed", errorMessage);
      return;
    }

    const advance = await advanceChain(
      { store: deps.store, launchLeg: deps.launchLeg },
      { task: record, settledLeg },
    );
    if (advance.kind === "dispatched" || advance.kind === "already-claimed") {
      // The task is still running: its work moved to the next agent,
      // and that agent's own terminal event will settle it.
      return;
    }
    if (advance.kind === "dispatch-failed") {
      await completeAndDeliver(
        agentAddress,
        record,
        "failed",
        advance.errorMessage,
      );
      return;
    }
    await completeAndDeliver(agentAddress, record, "done", errorMessage);
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

      const ended = messageRunEnded(event);
      if (ended === undefined) return;
      if (claimedAddresses.has(agentAddress)) return;
      claimedAddresses.add(agentAddress);

      void deliverTerminalTask(
        agentAddress,
        ended.status,
        ended.errorMessage,
      ).catch((cause: unknown) => {
        claimedAddresses.delete(agentAddress);
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
