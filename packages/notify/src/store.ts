// Persistence for the one dispatch table, kept apart from delivery and the
// worker so neither touches drizzle directly. `createInMemoryNotifyDispatchStore`
// is the fake this package's own tests drive the worker through.
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { generateId } from "@intx/hub-common";

import { notifyDispatch } from "./schema";

export type NotifyDb<TSchema extends Record<string, unknown> = Record<string, never>> =
  PostgresJsDatabase<TSchema>;

export type NotifyDispatchStatus = "pending" | "delivered" | "failed" | "dead";

export interface NotifyDispatchRow {
  readonly id: string;
  readonly mailboxRowId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly sinkName: string;
  readonly status: NotifyDispatchStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly nextAttemptAt: Date;
}

export interface EnqueueDispatchInput {
  readonly mailboxRowId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly sinkName: string;
}

export interface SettleDispatchInput {
  readonly id: string;
  readonly status: NotifyDispatchStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly nextAttemptAt: Date;
}

export interface NotifyDispatchStore {
  /** One row per (mail row, sink); a redelivered notification never queues a second copy. */
  enqueue(inputs: readonly EnqueueDispatchInput[]): Promise<void>;
  /** Rows whose next attempt is due, oldest first, across every tenant. */
  findDue(now: Date, limit: number): Promise<NotifyDispatchRow[]>;
  settle(input: SettleDispatchInput): Promise<void>;
  listFor(mailboxRowId: string): Promise<NotifyDispatchRow[]>;
}

const ACTIVE_STATUSES: NotifyDispatchStatus[] = ["pending", "failed"];

export function createDrizzleNotifyDispatchStore(db: NotifyDb): NotifyDispatchStore {
  return {
    async enqueue(inputs) {
      if (inputs.length === 0) return;
      await db
        .insert(notifyDispatch)
        .values(
          inputs.map((input) => ({
            id: generateId("signal"),
            mailboxRowId: input.mailboxRowId,
            tenantId: input.tenantId,
            principalId: input.principalId,
            sinkName: input.sinkName,
            status: "pending" as const,
          })),
        )
        .onConflictDoNothing();
    },

    async findDue(now, limit) {
      const rows = await db
        .select()
        .from(notifyDispatch)
        .where(
          and(
            inArray(notifyDispatch.status, ACTIVE_STATUSES),
            lte(notifyDispatch.nextAttemptAt, now),
          ),
        )
        .orderBy(asc(notifyDispatch.nextAttemptAt))
        .limit(limit);
      return rows.map(toRow);
    },

    async settle(input) {
      await db
        .update(notifyDispatch)
        .set({
          status: input.status,
          attempts: input.attempts,
          lastError: input.lastError,
          nextAttemptAt: input.nextAttemptAt,
          updatedAt: new Date(),
        })
        .where(eq(notifyDispatch.id, input.id));
    },

    async listFor(mailboxRowId) {
      const rows = await db
        .select()
        .from(notifyDispatch)
        .where(eq(notifyDispatch.mailboxRowId, mailboxRowId));
      return rows.map(toRow);
    },
  };
}

function toRow(row: typeof notifyDispatch.$inferSelect): NotifyDispatchRow {
  return {
    id: row.id,
    mailboxRowId: row.mailboxRowId,
    tenantId: row.tenantId,
    principalId: row.principalId,
    sinkName: row.sinkName,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt,
  };
}

export function createInMemoryNotifyDispatchStore(): NotifyDispatchStore {
  const rows = new Map<string, NotifyDispatchRow>();
  const keyOf = (mailboxRowId: string, sinkName: string) => `${mailboxRowId}\u0000${sinkName}`;
  return {
    async enqueue(inputs) {
      for (const input of inputs) {
        const key = keyOf(input.mailboxRowId, input.sinkName);
        if (rows.has(key)) continue;
        rows.set(key, {
          id: generateId("signal"),
          mailboxRowId: input.mailboxRowId,
          tenantId: input.tenantId,
          principalId: input.principalId,
          sinkName: input.sinkName,
          status: "pending",
          attempts: 0,
          lastError: null,
          nextAttemptAt: new Date(0),
        });
      }
    },
    async findDue(now, limit) {
      return [...rows.values()]
        .filter((row) => ACTIVE_STATUSES.includes(row.status) && row.nextAttemptAt <= now)
        .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
        .slice(0, limit);
    },
    async settle(input) {
      for (const [key, row] of rows) {
        if (row.id !== input.id) continue;
        rows.set(key, {
          id: row.id,
          mailboxRowId: row.mailboxRowId,
          tenantId: row.tenantId,
          principalId: row.principalId,
          sinkName: row.sinkName,
          status: input.status,
          attempts: input.attempts,
          lastError: input.lastError,
          nextAttemptAt: input.nextAttemptAt,
        });
      }
    },
    async listFor(mailboxRowId) {
      return [...rows.values()].filter((row) => row.mailboxRowId === mailboxRowId);
    },
  };
}
