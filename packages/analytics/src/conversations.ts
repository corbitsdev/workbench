import { and, count, eq, gte, lte, type AnyColumn } from "drizzle-orm";

import type { DB } from "@intx/db";
import { schema as intxSchema } from "@intx/db";

import type { AnalyticsDateRange } from "./queries";

export type ConversationActivity = {
  conversations: { total: number; createdInRange: number };
  messages: { total: number; createdInRange: number };
};

function rangeFilter(column: AnyColumn, range?: AnalyticsDateRange) {
  if (range?.startDate === undefined && range?.endDate === undefined) {
    return undefined;
  }
  const start = range?.startDate
    ? new Date(`${range.startDate}T00:00:00.000Z`)
    : undefined;
  const end = range?.endDate
    ? new Date(`${range.endDate}T23:59:59.999Z`)
    : undefined;
  return and(
    start !== undefined ? gte(column, start) : undefined,
    end !== undefined ? lte(column, end) : undefined,
  );
}

export async function getConversationActivity(args: {
  db: DB["db"];
  tenantId: string;
  range?: AnalyticsDateRange;
}): Promise<ConversationActivity> {
  const { db, tenantId, range } = args;
  const sessionTenant = eq(intxSchema.agentSession.tenantId, tenantId);
  const turnTenant = eq(intxSchema.inferenceTurn.tenantId, tenantId);

  const [
    conversationTotalRow,
    conversationInRangeRow,
    messageTotalRow,
    messageInRangeRow,
  ] = await Promise.all([
    db
      .select({ count: count() })
      .from(intxSchema.agentSession)
      .where(sessionTenant),
    db
      .select({ count: count() })
      .from(intxSchema.agentSession)
      .where(
        and(
          sessionTenant,
          rangeFilter(intxSchema.agentSession.createdAt, range),
        ),
      ),
    db
      .select({ count: count() })
      .from(intxSchema.inferenceTurn)
      .where(turnTenant),
    db
      .select({ count: count() })
      .from(intxSchema.inferenceTurn)
      .where(
        and(turnTenant, rangeFilter(intxSchema.inferenceTurn.startedAt, range)),
      ),
  ]);

  return {
    conversations: {
      total: Number(conversationTotalRow[0]?.count ?? 0),
      createdInRange: Number(conversationInRangeRow[0]?.count ?? 0),
    },
    messages: {
      total: Number(messageTotalRow[0]?.count ?? 0),
      createdInRange: Number(messageInRangeRow[0]?.count ?? 0),
    },
  };
}
