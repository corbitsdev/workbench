import { and, eq, sql } from "drizzle-orm";
import { type } from "arktype";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import { task, type TaskRow } from "../db/schema";
import type { WorkUnitQueue } from "./work-unit-queue";

const log = getLogger(["services", "agent-task-auto-pickup"]);

export const AGENT_TASK_TURN_KIND = "agent_task_turn" as const;

export const AgentTaskTurnPayloadSchema = type({
  taskId: "string",
  "reason?": "string",
  "policyVersion?": "string",
  "assigneePrincipalId?": "string | null",
});
export type AgentTaskTurnPayload = typeof AgentTaskTurnPayloadSchema.infer;

export const AGENT_AUTO_PICKUP_POLICY_VERSION = "v1";

/** Env gate for auto-pickup. Default off until policy is validated in staging. */
export function agentAutoPickupEnabled(): boolean {
  const raw = process.env["AGENT_TASK_AUTO_PICKUP"];
  if (raw === undefined || raw.trim() === "") return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

/**
 * Policy v1: open tasks with a non-null assignee are eligible for auto-run.
 * Product task rows are never leased — only work units are.
 */
export async function selectEligibleTasksForAutoPickup(
  db: HubDb,
  args?: { tenantId?: string; limit?: number },
): Promise<TaskRow[]> {
  const limit = Math.max(1, Math.min(args?.limit ?? 20, 100));
  const conditions = [
    eq(task.status, "open"),
    sql`${task.assigneePrincipalId} is not null`,
  ];
  if (args?.tenantId) {
    conditions.push(eq(task.tenantId, args.tenantId));
  }

  return db
    .select()
    .from(task)
    .where(and(...conditions))
    .orderBy(task.updatedAt)
    .limit(limit);
}

export function agentTaskTurnIdempotencyKey(
  taskId: string,
  turnKey: string,
): string {
  return `task:${taskId}:turn:${turnKey}`;
}

/**
 * Enqueue one agent_task_turn work unit for a product task. Never locks the
 * task row. Idempotent per (tenant, kind, task:turnKey).
 */
export async function enqueueAgentTaskTurn(
  queue: WorkUnitQueue,
  args: {
    tenantId: string;
    taskId: string;
    turnKey: string;
    reason?: string;
    assigneePrincipalId?: string | null;
  },
): Promise<{ id: string; created: boolean }> {
  const payload: AgentTaskTurnPayload = {
    taskId: args.taskId,
    policyVersion: AGENT_AUTO_PICKUP_POLICY_VERSION,
    ...(args.reason !== undefined ? { reason: args.reason } : {}),
    ...(args.assigneePrincipalId !== undefined
      ? { assigneePrincipalId: args.assigneePrincipalId }
      : {}),
  };

  return queue.enqueue({
    tenantId: args.tenantId,
    kind: AGENT_TASK_TURN_KIND,
    idempotencyKey: agentTaskTurnIdempotencyKey(args.taskId, args.turnKey),
    payload,
  });
}

/**
 * Scan eligible product tasks and enqueue turns. Live units for the same
 * turn key are deduped by the work_unit unique constraint.
 */
export async function enqueueDueAgentTaskTurns(
  db: HubDb,
  queue: WorkUnitQueue,
  args?: { tenantId?: string; limit?: number; turnKey?: string },
): Promise<{ scanned: number; enqueued: number }> {
  if (!agentAutoPickupEnabled()) {
    return { scanned: 0, enqueued: 0 };
  }

  const turnKey = args?.turnKey ?? "auto";
  const eligible = await selectEligibleTasksForAutoPickup(db, {
    tenantId: args?.tenantId,
    limit: args?.limit,
  });

  let enqueued = 0;
  for (const t of eligible) {
    try {
      const result = await enqueueAgentTaskTurn(queue, {
        tenantId: t.tenantId,
        taskId: t.id,
        turnKey,
        reason: "auto_pickup_policy_v1",
        assigneePrincipalId: t.assigneePrincipalId,
      });
      if (result.created) enqueued += 1;
    } catch (err) {
      log.error("agent auto-pickup: enqueue failed for task {taskId}", {
        taskId: t.id,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  return { scanned: eligible.length, enqueued };
}

export type AgentTaskTurnRunner = (args: {
  tenantId: string;
  payload: AgentTaskTurnPayload;
  signal: AbortSignal;
}) => Promise<{ statusUpdated?: boolean }>;

/**
 * Run one claimed agent_task_turn. Does not FOR UPDATE the product task.
 * The runner launches/resumes an Interchange session (or one-shot); approvals
 * still gate external side effects inside that session.
 */
export async function runAgentTaskTurnUnit(args: {
  tenantId: string;
  payload: unknown;
  runner: AgentTaskTurnRunner;
  signal: AbortSignal;
}): Promise<{ statusUpdated?: boolean }> {
  const parsed = AgentTaskTurnPayloadSchema(args.payload);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid agent_task_turn payload: ${parsed.summary}`);
  }
  return args.runner({
    tenantId: args.tenantId,
    payload: parsed,
    signal: args.signal,
  });
}

/**
 * Default runner stub used until per-agent session launch is wired. Updates
 * the product task to in_progress when still open — outcome of the turn, not
 * the lease mechanism. Never locks the task for claim.
 */
export function createDefaultAgentTaskTurnRunner(
  db: HubDb,
): AgentTaskTurnRunner {
  return async ({ payload }) => {
    const updated = await db
      .update(task)
      .set({ status: "in_progress" })
      .where(and(eq(task.id, payload.taskId), eq(task.status, "open")))
      .returning({ id: task.id });
    return { statusUpdated: updated.length > 0 };
  };
}
