// Persistence for the `task` product table, kept apart from route and
// launch wiring so those layers never touch drizzle directly.
// `TaskStore` is the seam every other module depends on;
// `createDrizzleTaskStore` is its production implementation over
// `./schema.ts`, and `createMemoryTaskStore` is the in-memory test
// double — both satisfy the same interface, so routes/orchestrator
// tests never need a database.
import { and, desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { task, type TaskStatus } from "./schema";

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
  readonly prompt: string;
  readonly modelPreference: string | null;
  readonly status: TaskStatus;
  readonly runId: string;
  readonly resultMailId: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface CreateTaskInput {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly definitionId: string;
  readonly prompt: string;
  readonly modelPreference: string | null;
  readonly runId: string;
  readonly createdAt?: Date;
}

export interface CompleteTaskInput {
  readonly tenantId: string;
  readonly id: string;
  readonly status: Extract<TaskStatus, "done" | "failed">;
  readonly resultMailId: string | null;
  readonly completedAt?: Date;
}

export interface TaskStore {
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  getTask(tenantId: string, id: string): Promise<TaskRecord | null>;
  getTaskByRunId(runId: string): Promise<TaskRecord | null>;
  listTasks(tenantId: string): Promise<readonly TaskRecord[]>;
  completeTask(input: CompleteTaskInput): Promise<TaskRecord | null>;
}

function toRecord(row: typeof task.$inferSelect): TaskRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    principalId: row.principalId,
    definitionId: row.definitionId,
    prompt: row.prompt,
    modelPreference: row.modelPreference,
    status: row.status,
    runId: row.runId,
    resultMailId: row.resultMailId,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

export function createDrizzleTaskStore<TSchema extends Record<string, unknown>>(
  db: TaskDb<TSchema>,
): TaskStore {
  return {
    async createTask(input) {
      const createdAt = input.createdAt ?? new Date();
      const [row] = await db
        .insert(task)
        .values({
          id: input.id,
          tenantId: input.tenantId,
          principalId: input.principalId,
          definitionId: input.definitionId,
          prompt: input.prompt,
          modelPreference: input.modelPreference,
          status: "running",
          runId: input.runId,
          resultMailId: null,
          createdAt,
          completedAt: null,
        })
        .returning();
      if (row === undefined) {
        throw new Error(`failed to insert task "${input.id}"`);
      }
      return toRecord(row);
    },

    async getTask(tenantId, id) {
      const [row] = await db
        .select()
        .from(task)
        .where(and(eq(task.tenantId, tenantId), eq(task.id, id)))
        .limit(1);
      return row === undefined ? null : toRecord(row);
    },

    async getTaskByRunId(runId) {
      const [row] = await db
        .select()
        .from(task)
        .where(eq(task.runId, runId))
        .limit(1);
      return row === undefined ? null : toRecord(row);
    },

    async listTasks(tenantId) {
      const rows = await db
        .select()
        .from(task)
        .where(eq(task.tenantId, tenantId))
        .orderBy(desc(task.createdAt));
      return rows.map(toRecord);
    },

    async completeTask(input) {
      const completedAt = input.completedAt ?? new Date();
      const [row] = await db
        .update(task)
        .set({
          status: input.status,
          resultMailId: input.resultMailId,
          completedAt,
        })
        .where(and(eq(task.tenantId, input.tenantId), eq(task.id, input.id)))
        .returning();
      return row === undefined ? null : toRecord(row);
    },
  };
}

/**
 * In-memory store for unit tests and local smoke — no database, no
 * drizzle query-builder internals involved.
 */
export function createMemoryTaskStore(): TaskStore {
  const tasks = new Map<string, TaskRecord>();

  return {
    async createTask(input) {
      if (tasks.has(input.id)) {
        throw new Error(`task "${input.id}" already exists`);
      }
      const record: TaskRecord = {
        id: input.id,
        tenantId: input.tenantId,
        principalId: input.principalId,
        definitionId: input.definitionId,
        prompt: input.prompt,
        modelPreference: input.modelPreference,
        status: "running",
        runId: input.runId,
        resultMailId: null,
        createdAt: input.createdAt ?? new Date(),
        completedAt: null,
      };
      tasks.set(record.id, record);
      return record;
    },

    async getTask(tenantId, id) {
      const record = tasks.get(id);
      return record !== undefined && record.tenantId === tenantId
        ? record
        : null;
    },

    async getTaskByRunId(runId) {
      for (const record of tasks.values()) {
        if (record.runId === runId) return record;
      }
      return null;
    },

    async listTasks(tenantId) {
      return [...tasks.values()]
        .filter((record) => record.tenantId === tenantId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    async completeTask(input) {
      const record = tasks.get(input.id);
      if (record === undefined || record.tenantId !== input.tenantId) {
        return null;
      }
      const updated: TaskRecord = {
        ...record,
        status: input.status,
        resultMailId: input.resultMailId,
        completedAt: input.completedAt ?? new Date(),
      };
      tasks.set(record.id, updated);
      return updated;
    },
  };
}
