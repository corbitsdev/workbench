// Describe-to-agent drafting for routines. Path (a) from-catalog creates
// a runnable routine immediately; path (b) stores a draft, runs a
// drafting proposal (via the host's drafting port — typically the bench
// default agent), then only approval materializes a routine row.
//
// Draft state machine: draft → reviewed → approved | discarded.
// Only `approved` creates a runnable routine (definition pin + schedule
// + delivery workbench captured at approval).

import { and, desc, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { generateId } from "@intx/hub-common";
import { type } from "arktype";

import { routineDraft } from "./schema";
import type { RoutineTriggerT } from "./trigger";
import { RoutineTrigger } from "./trigger";

export type DraftStatus = "draft" | "reviewed" | "approved" | "discarded";

export type DraftedStep = {
  readonly title: string;
  readonly detail?: string;
};

export type RoutineDraftRow = {
  readonly id: string;
  readonly tenantId: string;
  readonly prompt: string;
  readonly status: DraftStatus;
  readonly proposedSteps: readonly DraftedStep[];
  readonly proposedTrigger: RoutineTriggerT | null;
  readonly proposedName: string | null;
  readonly definitionId: string | null;
  readonly deliveryWorkbenchId: string;
  readonly scope: "personal" | "bench";
  readonly autonomy: Record<string, unknown> | null;
  readonly createdBy: string;
  readonly approvedRoutineId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type CreateDraftInput = {
  readonly tenantId: string;
  readonly prompt: string;
  readonly deliveryWorkbenchId: string;
  readonly scope: "personal" | "bench";
  readonly createdBy: string;
};

export type ReviewDraftInput = {
  readonly proposedSteps: readonly DraftedStep[];
  readonly proposedTrigger?: RoutineTriggerT | null;
  readonly proposedName?: string | null;
  readonly definitionId?: string | null;
  readonly autonomy?: Record<string, unknown> | null;
};

export const DraftedStepSchema = type({
  title: "string",
  "detail?": "string",
});

export function parseDraftStatus(raw: string): DraftStatus {
  if (
    raw === "draft" ||
    raw === "reviewed" ||
    raw === "approved" ||
    raw === "discarded"
  ) {
    return raw;
  }
  throw new Error(`unknown draft status: ${raw}`);
}

/**
 * Pure transition table. Invalid transitions throw — never silent no-ops.
 */
export function nextDraftStatus(
  current: DraftStatus,
  event: "review" | "approve" | "discard",
): DraftStatus {
  if (event === "discard") {
    if (current === "approved" || current === "discarded") {
      throw new Error(`cannot discard a ${current} draft`);
    }
    return "discarded";
  }
  if (event === "review") {
    if (current !== "draft" && current !== "reviewed") {
      throw new Error(`cannot review a ${current} draft`);
    }
    return "reviewed";
  }
  // approve
  if (current !== "reviewed") {
    throw new Error(`cannot approve a ${current} draft — review first`);
  }
  return "approved";
}

export interface RoutineDraftStore {
  createDraft(input: CreateDraftInput): Promise<RoutineDraftRow>;
  getDraft(
    tenantId: string,
    draftId: string,
  ): Promise<RoutineDraftRow | undefined>;
  listDrafts(tenantId: string): Promise<RoutineDraftRow[]>;
  markReviewed(
    tenantId: string,
    draftId: string,
    review: ReviewDraftInput,
  ): Promise<RoutineDraftRow>;
  markApproved(
    tenantId: string,
    draftId: string,
    routineId: string,
  ): Promise<RoutineDraftRow>;
  markDiscarded(tenantId: string, draftId: string): Promise<RoutineDraftRow>;
}

/**
 * Host-provided drafting: turn a free-text prompt into proposed steps.
 * Hub wires this to the bench default agent; tests inject a stub.
 */
export interface RoutineDraftingPort {
  propose(input: {
    tenantId: string;
    principalId: string;
    prompt: string;
  }): Promise<{
    steps: readonly DraftedStep[];
    name?: string;
    trigger?: RoutineTriggerT | null;
    definitionId?: string;
    autonomy?: Record<string, unknown>;
  }>;
}

function asSteps(raw: unknown): DraftedStep[] {
  if (!Array.isArray(raw)) return [];
  const out: DraftedStep[] = [];
  for (const item of raw) {
    const parsed = DraftedStepSchema(item);
    if (parsed instanceof type.errors) continue;
    out.push(
      parsed.detail !== undefined
        ? { title: parsed.title, detail: parsed.detail }
        : { title: parsed.title },
    );
  }
  return out;
}

function asTrigger(raw: unknown): RoutineTriggerT | null {
  if (raw === null || raw === undefined) return null;
  const parsed = RoutineTrigger(raw);
  if (parsed instanceof type.errors) return null;
  return parsed as RoutineTriggerT;
}

function requireReturningRow<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`expected ${what} row from returning()`);
  }
  return row;
}

function mapDraft(row: typeof routineDraft.$inferSelect): RoutineDraftRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    prompt: row.prompt,
    status: parseDraftStatus(row.status),
    proposedSteps: asSteps(row.proposedSteps),
    proposedTrigger: asTrigger(row.proposedTrigger),
    proposedName: row.proposedName ?? null,
    definitionId: row.definitionId ?? null,
    deliveryWorkbenchId: row.deliveryWorkbenchId,
    scope: row.scope === "personal" ? "personal" : "bench",
    autonomy:
      row.autonomy !== null && typeof row.autonomy === "object"
        ? (row.autonomy as Record<string, unknown>)
        : null,
    createdBy: row.createdBy,
    approvedRoutineId: row.approvedRoutineId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type DraftDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export function createInMemoryDraftStore(): RoutineDraftStore {
  const rows = new Map<string, RoutineDraftRow>();

  return {
    async createDraft(input) {
      const now = new Date();
      const row: RoutineDraftRow = {
        id: generateId("workflowRun"),
        tenantId: input.tenantId,
        prompt: input.prompt,
        status: "draft",
        proposedSteps: [],
        proposedTrigger: null,
        proposedName: null,
        definitionId: null,
        deliveryWorkbenchId: input.deliveryWorkbenchId,
        scope: input.scope,
        autonomy: null,
        createdBy: input.createdBy,
        approvedRoutineId: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(`${input.tenantId}:${row.id}`, row);
      return row;
    },

    async getDraft(tenantId, draftId) {
      return rows.get(`${tenantId}:${draftId}`);
    },

    async listDrafts(tenantId) {
      return [...rows.values()]
        .filter((r) => r.tenantId === tenantId && r.status !== "discarded")
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    async markReviewed(tenantId, draftId, review) {
      const key = `${tenantId}:${draftId}`;
      const cur = rows.get(key);
      if (cur === undefined) throw new Error("draft not found");
      const status = nextDraftStatus(cur.status, "review");
      const next: RoutineDraftRow = {
        ...cur,
        status,
        proposedSteps: [...review.proposedSteps],
        proposedTrigger:
          review.proposedTrigger !== undefined
            ? review.proposedTrigger
            : cur.proposedTrigger,
        proposedName:
          review.proposedName !== undefined
            ? review.proposedName
            : cur.proposedName,
        definitionId:
          review.definitionId !== undefined
            ? review.definitionId
            : cur.definitionId,
        autonomy:
          review.autonomy !== undefined ? review.autonomy : cur.autonomy,
        updatedAt: new Date(),
      };
      rows.set(key, next);
      return next;
    },

    async markApproved(tenantId, draftId, routineId) {
      const key = `${tenantId}:${draftId}`;
      const cur = rows.get(key);
      if (cur === undefined) throw new Error("draft not found");
      const status = nextDraftStatus(cur.status, "approve");
      const next: RoutineDraftRow = {
        ...cur,
        status,
        approvedRoutineId: routineId,
        updatedAt: new Date(),
      };
      rows.set(key, next);
      return next;
    },

    async markDiscarded(tenantId, draftId) {
      const key = `${tenantId}:${draftId}`;
      const cur = rows.get(key);
      if (cur === undefined) throw new Error("draft not found");
      const status = nextDraftStatus(cur.status, "discard");
      const next: RoutineDraftRow = {
        ...cur,
        status,
        updatedAt: new Date(),
      };
      rows.set(key, next);
      return next;
    },
  };
}

export function createDrizzleDraftStore<
  TSchema extends Record<string, unknown>,
>(db: DraftDb<TSchema>): RoutineDraftStore {
  return {
    async createDraft(input) {
      const id = generateId("workflowRun");
      const inserted = await db
        .insert(routineDraft)
        .values({
          id,
          tenantId: input.tenantId,
          prompt: input.prompt,
          status: "draft",
          proposedSteps: [],
          proposedTrigger: null,
          proposedName: null,
          definitionId: null,
          deliveryWorkbenchId: input.deliveryWorkbenchId,
          scope: input.scope,
          autonomy: null,
          createdBy: input.createdBy,
          approvedRoutineId: null,
        })
        .returning();
      return mapDraft(requireReturningRow(inserted, "routine draft"));
    },

    async getDraft(tenantId, draftId) {
      const rows = await db
        .select()
        .from(routineDraft)
        .where(
          and(
            eq(routineDraft.tenantId, tenantId),
            eq(routineDraft.id, draftId),
          ),
        )
        .limit(1);
      return rows[0] ? mapDraft(rows[0]) : undefined;
    },

    async listDrafts(tenantId) {
      const rows = await db
        .select()
        .from(routineDraft)
        .where(
          and(
            eq(routineDraft.tenantId, tenantId),
            // list excludes discarded
          ),
        )
        .orderBy(desc(routineDraft.createdAt));
      return rows.map(mapDraft).filter((r) => r.status !== "discarded");
    },

    async markReviewed(tenantId, draftId, review) {
      const cur = await this.getDraft(tenantId, draftId);
      if (cur === undefined) throw new Error("draft not found");
      const status = nextDraftStatus(cur.status, "review");
      const updated = await db
        .update(routineDraft)
        .set({
          status,
          proposedSteps: [...review.proposedSteps],
          proposedTrigger:
            review.proposedTrigger !== undefined
              ? review.proposedTrigger
              : cur.proposedTrigger,
          proposedName:
            review.proposedName !== undefined
              ? review.proposedName
              : cur.proposedName,
          definitionId:
            review.definitionId !== undefined
              ? review.definitionId
              : cur.definitionId,
          autonomy:
            review.autonomy !== undefined ? review.autonomy : cur.autonomy,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(routineDraft.tenantId, tenantId),
            eq(routineDraft.id, draftId),
          ),
        )
        .returning();
      return mapDraft(requireReturningRow(updated, "reviewed draft"));
    },

    async markApproved(tenantId, draftId, routineId) {
      const cur = await this.getDraft(tenantId, draftId);
      if (cur === undefined) throw new Error("draft not found");
      const status = nextDraftStatus(cur.status, "approve");
      const updated = await db
        .update(routineDraft)
        .set({
          status,
          approvedRoutineId: routineId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(routineDraft.tenantId, tenantId),
            eq(routineDraft.id, draftId),
          ),
        )
        .returning();
      return mapDraft(requireReturningRow(updated, "approved draft"));
    },

    async markDiscarded(tenantId, draftId) {
      const cur = await this.getDraft(tenantId, draftId);
      if (cur === undefined) throw new Error("draft not found");
      const status = nextDraftStatus(cur.status, "discard");
      const updated = await db
        .update(routineDraft)
        .set({ status, updatedAt: new Date() })
        .where(
          and(
            eq(routineDraft.tenantId, tenantId),
            eq(routineDraft.id, draftId),
          ),
        )
        .returning();
      return mapDraft(requireReturningRow(updated, "discarded draft"));
    },
  };
}

// silence unused import when drizzle path is tree-shaken in tests
void isNull;
