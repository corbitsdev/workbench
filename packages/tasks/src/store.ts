// Persistence for the `task` and `task_leg` product tables, kept apart
// from route and launch wiring so those layers never touch drizzle
// directly. `TaskStore` is the seam every other module depends on;
// `createDrizzleTaskStore` is its production implementation over
// `./schema.ts`, and `createMemoryTaskStore` is the in-memory test
// double — both satisfy the same interface, so routes/orchestrator
// tests never need a database.
import { and, asc, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { task, taskLeg, type TaskLegStatus, type TaskStatus } from "./schema";

/**
 * The drizzle handle `createDrizzleTaskStore` operates against.
 * Generic over the host's schema record, like `@corbits/chat`'s
 * `ChatDb` — the host hands in its own `drizzle(sql, { schema })`
 * instance unchanged, whatever its schema, and no cast is needed at
 * the call site.
 */
export type TaskDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export interface TaskRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly definitionId: string;
  readonly agentName: string;
  readonly prompt: string;
  readonly modelPreference: string | null;
  readonly status: TaskStatus;
  readonly runId: string;
  /**
   * Every run this task has spanned so far, in leg order — one entry
   * for a single-agent task, one per hand-off for a chained one. The
   * trace surfaces read this, never `runId` alone.
   */
  readonly runIds: readonly string[];
  /** How many legs the task was launched with, run or not yet run. */
  readonly stepCount: number;
  readonly resultMailId: string | null;
  readonly plannerRunId: string | null;
  /** The channel this task was dispatched from, when it was dispatched
   * from inside a workbench — null for a direct planner-API launch. */
  readonly channelId: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface TaskLegRecord {
  readonly id: string;
  readonly taskId: string;
  readonly tenantId: string;
  readonly position: number;
  readonly definitionId: string;
  readonly prompt: string;
  readonly modelPreference: string | null;
  readonly parentRunId: string | null;
  readonly messageId: string;
  readonly runId: string | null;
  readonly status: TaskLegStatus;
  readonly leaseExpiresAt: Date | null;
  readonly errorMessage: string | null;
  readonly createdAt: Date;
  /** When this leg's agent was handed its prompt — null for a leg that
   * never got that far, however its status later settled. */
  readonly startedAt: Date | null;
  readonly settledAt: Date | null;
}

/** One leg of a task as it is declared at launch, before any run exists. */
export interface TaskLegSpec {
  readonly definitionId: string;
  readonly prompt: string;
  readonly modelPreference: string | null;
}

export interface CreateTaskInput {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly definitionId: string;
  readonly agentName: string;
  readonly prompt: string;
  readonly modelPreference: string | null;
  readonly plannerRunId?: string | null;
  readonly channelId?: string | null;
  readonly runId: string;
  readonly createdAt?: Date;
  /** Legs after the first, in the order they will be handed through. */
  readonly followOn?: readonly TaskLegSpec[];
}

export interface CompleteTaskInput {
  readonly tenantId: string;
  readonly id: string;
  readonly status: Extract<TaskStatus, "done" | "failed">;
  readonly completedAt?: Date;
}

export interface RecordResultMailInput {
  readonly tenantId: string;
  readonly id: string;
  readonly resultMailId: string;
}

export interface RecordChannelInput {
  readonly tenantId: string;
  readonly id: string;
  readonly channelId: string;
}

export interface LinkPlannerRunInput {
  readonly tenantId: string;
  readonly id: string;
  readonly plannerRunId: string;
}

export interface ClaimLegDispatchInput {
  readonly tenantId: string;
  readonly legId: string;
  readonly parentRunId: string;
  readonly leaseExpiresAt: Date;
  readonly now: Date;
}

export interface RecordLegRunInput {
  readonly tenantId: string;
  readonly legId: string;
  readonly runId: string;
}

export interface StuckLegDispatchesInput {
  /** Legs whose lease had already passed at this instant. */
  readonly claimedBefore: Date;
}

export interface ConfirmLegDeliveryInput {
  readonly tenantId: string;
  readonly legId: string;
  readonly startedAt?: Date;
}

export interface SettleLegInput {
  readonly tenantId: string;
  readonly legId: string;
  readonly status: Extract<TaskLegStatus, "done" | "failed">;
  readonly errorMessage?: string;
  readonly settledAt?: Date;
}

export interface FailLegDispatchInput {
  readonly tenantId: string;
  readonly legId: string;
  readonly errorMessage: string;
  readonly settledAt?: Date;
}

export interface TaskStore {
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  getTask(tenantId: string, id: string): Promise<TaskRecord | null>;
  /** Resolves the task ANY of its legs' runs belongs to. */
  getTaskByRunId(runId: string): Promise<TaskRecord | null>;
  listTasks(tenantId: string): Promise<readonly TaskRecord[]>;
  /**
   * Flips a still-`running` task to its terminal status — conditionally,
   * winner-takes-all: the update only matches `status = 'running'`, so
   * of two racing callers (a redelivered terminal event, a second host
   * process) exactly one gets the row back and the loser gets `null`.
   * Only the winner may deliver the result mail.
   */
  completeTask(input: CompleteTaskInput): Promise<TaskRecord | null>;
  /** Stamps the delivered inbox mail id onto an already-completed task. */
  recordResultMail(input: RecordResultMailInput): Promise<void>;
  /** Stamps the originating channel onto a task dispatched from inside
   * a workbench — set once, right after dispatch, by the caller that
   * resolved the dispatching run's own channel. */
  recordChannel(input: RecordChannelInput): Promise<void>;
  /**
   * Stamps the planner run id onto a task that a planner dispatched on
   * the caller's behalf — set once, immediately after `launchTask`
   * returns, never revisited.
   */
  linkPlannerRun(input: LinkPlannerRunInput): Promise<void>;

  listLegs(tenantId: string, taskId: string): Promise<readonly TaskLegRecord[]>;
  getLegByRunId(runId: string): Promise<TaskLegRecord | null>;
  /**
   * Takes the launch claim on a leg — conditionally, winner-takes-all,
   * the same shape `completeTask` uses. The claim matches a `pending`
   * leg, or a `dispatching` leg whose lease has passed WITHOUT ever
   * recording a run: an expired lease redelivers a launch that never
   * happened and can never re-launch one that did.
   */
  claimLegDispatch(input: ClaimLegDispatchInput): Promise<TaskLegRecord | null>;
  /**
   * Stamps the launched run onto a claimed leg. The leg stays
   * `dispatching`: the run exists, but its agent has not been given the
   * prompt yet, and a leg that never gets one must remain in the state
   * `failLegDispatch` can settle.
   */
  recordLegRun(input: RecordLegRunInput): Promise<TaskLegRecord | null>;
  /** Starts a claimed leg whose agent has now received its prompt. */
  confirmLegDelivery(
    input: ConfirmLegDeliveryInput,
  ): Promise<TaskLegRecord | null>;
  /**
   * Every leg, across every tenant, still claimed after its lease ran
   * out — a hand-off no one is carrying and no settlement will
   * redeliver. The sweep in `./stuck-legs.ts` is the only caller.
   */
  listStuckLegDispatches(
    input: StuckLegDispatchesInput,
  ): Promise<readonly TaskLegRecord[]>;
  /** Flips a still-`running` leg terminal, winner-takes-all per leg. */
  settleLeg(input: SettleLegInput): Promise<TaskLegRecord | null>;
  /** Fails a claimed leg whose agent never received its prompt. */
  failLegDispatch(input: FailLegDispatchInput): Promise<TaskLegRecord | null>;
}

function legMessageId(taskId: string, position: number): string {
  return `chain:${taskId}:${String(position)}`;
}

function legId(): string {
  return `tleg_${crypto.randomUUID().replace(/-/g, "")}`;
}

function toLegRecord(row: typeof taskLeg.$inferSelect): TaskLegRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    tenantId: row.tenantId,
    position: row.position,
    definitionId: row.definitionId,
    prompt: row.prompt,
    modelPreference: row.modelPreference,
    parentRunId: row.parentRunId,
    messageId: row.messageId,
    runId: row.runId,
    status: row.status,
    leaseExpiresAt: row.leaseExpiresAt,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    settledAt: row.settledAt,
  };
}

function orderedLegs(legs: readonly TaskLegRecord[]): readonly TaskLegRecord[] {
  return [...legs].sort((a, b) => a.position - b.position);
}

function toRecord(
  row: typeof task.$inferSelect,
  legs: readonly TaskLegRecord[],
): TaskRecord {
  const ordered = orderedLegs(legs);
  return {
    id: row.id,
    tenantId: row.tenantId,
    principalId: row.principalId,
    definitionId: row.definitionId,
    agentName: row.agentName,
    prompt: row.prompt,
    modelPreference: row.modelPreference,
    status: row.status,
    runId: row.runId,
    // Only legs whose agent actually received its prompt: a run that
    // was created and never told what to do is not a run this task
    // passed through, and counting it would report the work stopping
    // one agent later than it did.
    runIds: ordered
      .filter((leg) => leg.startedAt !== null)
      .map((leg) => leg.runId)
      .filter((runId): runId is string => runId !== null),
    stepCount: ordered.length,
    resultMailId: row.resultMailId,
    plannerRunId: row.plannerRunId,
    channelId: row.channelId,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

/**
 * The full leg set a task is launched with: the first leg already
 * running against `input.runId`, and every declared hand-off pending
 * behind it. Shared by both store implementations so a launch writes
 * the same rows with or without a database.
 */
export function taskLegLaunchRows(
  input: CreateTaskInput,
  createdAt: Date,
): (typeof taskLeg.$inferInsert)[] {
  const first: typeof taskLeg.$inferInsert = {
    id: legId(),
    taskId: input.id,
    tenantId: input.tenantId,
    position: 0,
    definitionId: input.definitionId,
    prompt: input.prompt,
    modelPreference: input.modelPreference,
    parentRunId: null,
    messageId: legMessageId(input.id, 0),
    runId: input.runId,
    status: "running",
    leaseExpiresAt: null,
    errorMessage: null,
    createdAt,
    startedAt: createdAt,
    settledAt: null,
  };
  const followOn = (input.followOn ?? []).map((spec, index) => {
    const position = index + 1;
    const row: typeof taskLeg.$inferInsert = {
      id: legId(),
      taskId: input.id,
      tenantId: input.tenantId,
      position,
      definitionId: spec.definitionId,
      prompt: spec.prompt,
      modelPreference: spec.modelPreference,
      parentRunId: null,
      messageId: legMessageId(input.id, position),
      runId: null,
      status: "pending",
      leaseExpiresAt: null,
      errorMessage: null,
      createdAt,
      startedAt: null,
      settledAt: null,
    };
    return row;
  });
  return [first, ...followOn];
}

export function createDrizzleTaskStore<TSchema extends Record<string, unknown>>(
  db: TaskDb<TSchema>,
): TaskStore {
  async function legsForTasks(
    taskIds: readonly string[],
  ): Promise<Map<string, TaskLegRecord[]>> {
    const byTask = new Map<string, TaskLegRecord[]>();
    if (taskIds.length === 0) return byTask;
    const rows = await db
      .select()
      .from(taskLeg)
      .where(inArray(taskLeg.taskId, [...taskIds]))
      .orderBy(asc(taskLeg.position));
    for (const row of rows) {
      const record = toLegRecord(row);
      const bucket = byTask.get(record.taskId);
      if (bucket === undefined) byTask.set(record.taskId, [record]);
      else bucket.push(record);
    }
    return byTask;
  }

  async function legsFor(taskId: string): Promise<TaskLegRecord[]> {
    return (await legsForTasks([taskId])).get(taskId) ?? [];
  }

  async function taskWithLegs(
    row: typeof task.$inferSelect | undefined,
  ): Promise<TaskRecord | null> {
    if (row === undefined) return null;
    return toRecord(row, await legsFor(row.id));
  }

  return {
    async createTask(input) {
      const createdAt = input.createdAt ?? new Date();
      const row = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(task)
          .values({
            id: input.id,
            tenantId: input.tenantId,
            principalId: input.principalId,
            definitionId: input.definitionId,
            agentName: input.agentName,
            prompt: input.prompt,
            modelPreference: input.modelPreference,
            status: "running",
            runId: input.runId,
            resultMailId: null,
            plannerRunId: input.plannerRunId ?? null,
            channelId: input.channelId ?? null,
            createdAt,
            completedAt: null,
          })
          .returning();
        await tx.insert(taskLeg).values(taskLegLaunchRows(input, createdAt));
        return inserted;
      });
      if (row === undefined) {
        throw new Error(`failed to insert task "${input.id}"`);
      }
      return toRecord(row, await legsFor(input.id));
    },

    async getTask(tenantId, id) {
      const [row] = await db
        .select()
        .from(task)
        .where(and(eq(task.tenantId, tenantId), eq(task.id, id)))
        .limit(1);
      return taskWithLegs(row);
    },

    async getTaskByRunId(runId) {
      const [leg] = await db
        .select()
        .from(taskLeg)
        .where(eq(taskLeg.runId, runId))
        .limit(1);
      if (leg === undefined) return null;
      const [row] = await db
        .select()
        .from(task)
        .where(eq(task.id, leg.taskId))
        .limit(1);
      return taskWithLegs(row);
    },

    async listTasks(tenantId) {
      const rows = await db
        .select()
        .from(task)
        .where(eq(task.tenantId, tenantId))
        .orderBy(desc(task.createdAt));
      const byTask = await legsForTasks(rows.map((row) => row.id));
      return rows.map((row) => toRecord(row, byTask.get(row.id) ?? []));
    },

    async completeTask(input) {
      const completedAt = input.completedAt ?? new Date();
      const [row] = await db
        .update(task)
        .set({
          status: input.status,
          completedAt,
        })
        .where(
          and(
            eq(task.tenantId, input.tenantId),
            eq(task.id, input.id),
            eq(task.status, "running"),
          ),
        )
        .returning();
      return taskWithLegs(row);
    },

    async recordResultMail(input) {
      await db
        .update(task)
        .set({ resultMailId: input.resultMailId })
        .where(and(eq(task.tenantId, input.tenantId), eq(task.id, input.id)));
    },

    async linkPlannerRun(input) {
      await db
        .update(task)
        .set({ plannerRunId: input.plannerRunId })
        .where(and(eq(task.tenantId, input.tenantId), eq(task.id, input.id)));
    },

    async recordChannel(input) {
      await db
        .update(task)
        .set({ channelId: input.channelId })
        .where(and(eq(task.tenantId, input.tenantId), eq(task.id, input.id)));
    },

    async listLegs(tenantId, taskId) {
      const rows = await db
        .select()
        .from(taskLeg)
        .where(and(eq(taskLeg.tenantId, tenantId), eq(taskLeg.taskId, taskId)))
        .orderBy(asc(taskLeg.position));
      return rows.map(toLegRecord);
    },

    async getLegByRunId(runId) {
      const [row] = await db
        .select()
        .from(taskLeg)
        .where(eq(taskLeg.runId, runId))
        .limit(1);
      return row === undefined ? null : toLegRecord(row);
    },

    async claimLegDispatch(input) {
      const [row] = await db
        .update(taskLeg)
        .set({
          status: "dispatching",
          parentRunId: input.parentRunId,
          leaseExpiresAt: input.leaseExpiresAt,
        })
        .where(
          and(
            eq(taskLeg.tenantId, input.tenantId),
            eq(taskLeg.id, input.legId),
            isNull(taskLeg.runId),
            or(
              eq(taskLeg.status, "pending"),
              and(
                eq(taskLeg.status, "dispatching"),
                lt(taskLeg.leaseExpiresAt, input.now),
              ),
            ),
          ),
        )
        .returning();
      return row === undefined ? null : toLegRecord(row);
    },

    async recordLegRun(input) {
      const [row] = await db
        .update(taskLeg)
        .set({ runId: input.runId })
        .where(
          and(
            eq(taskLeg.tenantId, input.tenantId),
            eq(taskLeg.id, input.legId),
            eq(taskLeg.status, "dispatching"),
          ),
        )
        .returning();
      return row === undefined ? null : toLegRecord(row);
    },

    async confirmLegDelivery(input) {
      const [row] = await db
        .update(taskLeg)
        .set({
          status: "running",
          leaseExpiresAt: null,
          startedAt: input.startedAt ?? new Date(),
        })
        .where(
          and(
            eq(taskLeg.tenantId, input.tenantId),
            eq(taskLeg.id, input.legId),
            eq(taskLeg.status, "dispatching"),
          ),
        )
        .returning();
      return row === undefined ? null : toLegRecord(row);
    },

    async listStuckLegDispatches(input) {
      const rows = await db
        .select()
        .from(taskLeg)
        .where(
          and(
            eq(taskLeg.status, "dispatching"),
            lt(taskLeg.leaseExpiresAt, input.claimedBefore),
          ),
        )
        .orderBy(asc(taskLeg.createdAt));
      return rows.map(toLegRecord);
    },

    async settleLeg(input) {
      const [row] = await db
        .update(taskLeg)
        .set({
          status: input.status,
          errorMessage: input.errorMessage ?? null,
          settledAt: input.settledAt ?? new Date(),
        })
        .where(
          and(
            eq(taskLeg.tenantId, input.tenantId),
            eq(taskLeg.id, input.legId),
            eq(taskLeg.status, "running"),
          ),
        )
        .returning();
      return row === undefined ? null : toLegRecord(row);
    },

    async failLegDispatch(input) {
      const [row] = await db
        .update(taskLeg)
        .set({
          status: "failed",
          errorMessage: input.errorMessage,
          leaseExpiresAt: null,
          settledAt: input.settledAt ?? new Date(),
        })
        .where(
          and(
            eq(taskLeg.tenantId, input.tenantId),
            eq(taskLeg.id, input.legId),
            eq(taskLeg.status, "dispatching"),
          ),
        )
        .returning();
      return row === undefined ? null : toLegRecord(row);
    },
  };
}

/**
 * In-memory store for unit tests and local smoke — no database, no
 * drizzle query-builder internals involved.
 */
export function createMemoryTaskStore(): TaskStore {
  const tasks = new Map<string, typeof task.$inferSelect>();
  const legs = new Map<string, TaskLegRecord>();

  function legsFor(taskId: string): TaskLegRecord[] {
    return [...legs.values()]
      .filter((leg) => leg.taskId === taskId)
      .sort((a, b) => a.position - b.position);
  }

  function recordFor(row: typeof task.$inferSelect): TaskRecord {
    return toRecord(row, legsFor(row.id));
  }

  return {
    async createTask(input) {
      if (tasks.has(input.id)) {
        throw new Error(`task "${input.id}" already exists`);
      }
      const createdAt = input.createdAt ?? new Date();
      const row: typeof task.$inferSelect = {
        id: input.id,
        tenantId: input.tenantId,
        principalId: input.principalId,
        definitionId: input.definitionId,
        agentName: input.agentName,
        prompt: input.prompt,
        modelPreference: input.modelPreference,
        status: "running",
        runId: input.runId,
        resultMailId: null,
        plannerRunId: input.plannerRunId ?? null,
        channelId: input.channelId ?? null,
        createdAt,
        completedAt: null,
      };
      tasks.set(row.id, row);
      for (const leg of taskLegLaunchRows(input, createdAt)) {
        legs.set(leg.id, {
          id: leg.id,
          taskId: leg.taskId,
          tenantId: leg.tenantId,
          position: leg.position,
          definitionId: leg.definitionId,
          prompt: leg.prompt,
          modelPreference: leg.modelPreference ?? null,
          parentRunId: leg.parentRunId ?? null,
          messageId: leg.messageId,
          runId: leg.runId ?? null,
          status: leg.status,
          leaseExpiresAt: leg.leaseExpiresAt ?? null,
          errorMessage: leg.errorMessage ?? null,
          createdAt,
          startedAt: leg.startedAt ?? null,
          settledAt: leg.settledAt ?? null,
        });
      }
      return recordFor(row);
    },

    async getTask(tenantId, id) {
      const row = tasks.get(id);
      return row !== undefined && row.tenantId === tenantId
        ? recordFor(row)
        : null;
    },

    async getTaskByRunId(runId) {
      for (const leg of legs.values()) {
        if (leg.runId !== runId) continue;
        const row = tasks.get(leg.taskId);
        return row === undefined ? null : recordFor(row);
      }
      return null;
    },

    async listTasks(tenantId) {
      return [...tasks.values()]
        .filter((row) => row.tenantId === tenantId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(recordFor);
    },

    async completeTask(input) {
      const row = tasks.get(input.id);
      if (
        row === undefined ||
        row.tenantId !== input.tenantId ||
        row.status !== "running"
      ) {
        return null;
      }
      const updated = {
        ...row,
        status: input.status,
        completedAt: input.completedAt ?? new Date(),
      };
      tasks.set(row.id, updated);
      return recordFor(updated);
    },

    async recordResultMail(input) {
      const row = tasks.get(input.id);
      if (row === undefined || row.tenantId !== input.tenantId) return;
      tasks.set(row.id, { ...row, resultMailId: input.resultMailId });
    },

    async linkPlannerRun(input) {
      const row = tasks.get(input.id);
      if (row === undefined || row.tenantId !== input.tenantId) return;
      tasks.set(row.id, { ...row, plannerRunId: input.plannerRunId });
    },

    async recordChannel(input) {
      const row = tasks.get(input.id);
      if (row === undefined || row.tenantId !== input.tenantId) return;
      tasks.set(row.id, { ...row, channelId: input.channelId });
    },

    async listLegs(tenantId, taskId) {
      return legsFor(taskId).filter((leg) => leg.tenantId === tenantId);
    },

    async getLegByRunId(runId) {
      for (const leg of legs.values()) {
        if (leg.runId === runId) return leg;
      }
      return null;
    },

    async claimLegDispatch(input) {
      const leg = legs.get(input.legId);
      if (leg === undefined || leg.tenantId !== input.tenantId) return null;
      if (leg.runId !== null) return null;
      const claimable =
        leg.status === "pending" ||
        (leg.status === "dispatching" &&
          leg.leaseExpiresAt !== null &&
          leg.leaseExpiresAt.getTime() < input.now.getTime());
      if (!claimable) return null;
      const updated: TaskLegRecord = {
        ...leg,
        status: "dispatching",
        parentRunId: input.parentRunId,
        leaseExpiresAt: input.leaseExpiresAt,
      };
      legs.set(leg.id, updated);
      return updated;
    },

    async recordLegRun(input) {
      const leg = legs.get(input.legId);
      if (
        leg === undefined ||
        leg.tenantId !== input.tenantId ||
        leg.status !== "dispatching"
      ) {
        return null;
      }
      const updated: TaskLegRecord = { ...leg, runId: input.runId };
      legs.set(leg.id, updated);
      return updated;
    },

    async confirmLegDelivery(input) {
      const leg = legs.get(input.legId);
      if (
        leg === undefined ||
        leg.tenantId !== input.tenantId ||
        leg.status !== "dispatching"
      ) {
        return null;
      }
      const updated: TaskLegRecord = {
        ...leg,
        status: "running",
        leaseExpiresAt: null,
        startedAt: input.startedAt ?? new Date(),
      };
      legs.set(leg.id, updated);
      return updated;
    },

    async listStuckLegDispatches(input) {
      return [...legs.values()]
        .filter(
          (leg) =>
            leg.status === "dispatching" &&
            leg.leaseExpiresAt !== null &&
            leg.leaseExpiresAt.getTime() < input.claimedBefore.getTime(),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },

    async settleLeg(input) {
      const leg = legs.get(input.legId);
      if (
        leg === undefined ||
        leg.tenantId !== input.tenantId ||
        leg.status !== "running"
      ) {
        return null;
      }
      const updated: TaskLegRecord = {
        ...leg,
        status: input.status,
        errorMessage: input.errorMessage ?? null,
        settledAt: input.settledAt ?? new Date(),
      };
      legs.set(leg.id, updated);
      return updated;
    },

    async failLegDispatch(input) {
      const leg = legs.get(input.legId);
      if (
        leg === undefined ||
        leg.tenantId !== input.tenantId ||
        leg.status !== "dispatching"
      ) {
        return null;
      }
      const updated: TaskLegRecord = {
        ...leg,
        status: "failed",
        errorMessage: input.errorMessage,
        leaseExpiresAt: null,
        settledAt: input.settledAt ?? new Date(),
      };
      legs.set(leg.id, updated);
      return updated;
    },
  };
}
