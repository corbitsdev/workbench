import { randomBytes } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';

import type { DB } from '@intx/db';
import { agentInstance } from '@intx/db/schema';
import { getLogger } from '@intx/log';
import type { InferenceEvent } from '@intx/types/runtime';

import { factsFromInferenceEvent, type AnalyticsFact } from './event-mapping';
import { analyticsEvent, analyticsRollupDaily } from './schema';

type Tx = Parameters<Parameters<DB['db']['transaction']>[0]>[0];

const log = getLogger(['hub', 'analytics']);

export type AnalyticsSubscriber = {
  onAgentEvent(args: { agentAddress: string; event: InferenceEvent }): Promise<void>;
};

export type AnalyticsSubscriberConfig = {
  db: DB['db'];
};

export function createAnalyticsSubscriber(config: AnalyticsSubscriberConfig): AnalyticsSubscriber {
  const { db } = config;

  return {
    async onAgentEvent({ agentAddress, event }) {
      const facts = factsFromInferenceEvent({ agentAddress, event });
      if (facts.length === 0) return;

      try {
        const instance = await findActiveInstance(db, agentAddress);
        if (instance === null) {
          log.warn('Skipping analytics event for unknown agent address: {agentAddress}', {
            agentAddress,
          });
          return;
        }

        for (const fact of facts) {
          await persistFact(db, instance, fact);
        }
      } catch (error) {
        log.warn('Failed to persist analytics event for {agentAddress}: {error}', {
          agentAddress,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

async function findActiveInstance(db: DB['db'], agentAddress: string) {
  return (
    (await db.query.agentInstance.findFirst({
      where: and(eq(agentInstance.address, agentAddress), isNull(agentInstance.endedAt)),
    })) ?? null
  );
}

type ActiveInstance = NonNullable<Awaited<ReturnType<typeof findActiveInstance>>>;

async function persistFact(
  db: DB['db'],
  instance: ActiveInstance,
  fact: AnalyticsFact
): Promise<void> {
  if (!instance.sessionId) {
    throw new Error(
      `agentInstance ${instance.id} has no sessionId — cannot build an idempotent event key`
    );
  }
  // Qualify the event key with sessionId so seq resets on agent restart don't
  // collide with prior-session rows and silently drop events.
  const sessionScopedKey = `${instance.sessionId}:${fact.eventKey}`;

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(analyticsEvent)
      .values({
        id: analyticsEventId(),
        tenantId: instance.tenantId,
        principalId: instance.principalId,
        agentId: instance.agentId,
        instanceId: instance.id,
        sessionId: instance.sessionId,
        toolCallId: fact.toolCallId,
        eventKey: sessionScopedKey,
        eventType: fact.eventType,
        model: fact.model,
        toolName: fact.toolName,
        status: fact.status,
        inputTokens: fact.inputTokens,
        outputTokens: fact.outputTokens,
        cacheReadTokens: fact.cacheReadTokens,
        cacheWriteTokens: fact.cacheWriteTokens,
        thinkingTokens: fact.thinkingTokens,
        source: fact.source,
        metadata: fact.metadata,
        occurredAt: fact.occurredAt,
      })
      .onConflictDoNothing({ target: analyticsEvent.eventKey })
      .returning({ id: analyticsEvent.id });

    if (inserted.length === 0) return;

    // inference_done contributes no rollup increments (token accounting lives
    // on inference_usage; skipping here avoids a no-op write on every turn).
    if (fact.eventType === 'inference_done') return;

    await upsertDailyRollup(tx, instance, fact);
  });
}

async function upsertDailyRollup(
  db: Tx,
  instance: ActiveInstance,
  fact: AnalyticsFact
): Promise<void> {
  const bucketDate = fact.occurredAt.toISOString().slice(0, 10);
  // toolName is not available from the current InferenceEvent shape and is
  // excluded from the rollup key to avoid spurious empty-string dimensions.
  const rollupKey = [
    instance.tenantId,
    instance.agentId,
    instance.id,
    fact.model ?? '',
    bucketDate,
  ].join(':');
  const turnCount = fact.eventType === 'turn_completed' ? 1 : 0;
  const failedTurnCount = fact.eventType === 'turn_failed' ? 1 : 0;
  const toolCallCount = fact.eventType === 'tool_call' ? 1 : 0;
  const toolErrorCount = fact.eventType === 'tool_call' && fact.status === 'error' ? 1 : 0;
  // inference_done carries the same TokenUsage as inference_usage for the same
  // LLM call. Only aggregate tokens from inference_usage to avoid double-counting.
  const countTokens = fact.eventType === 'inference_usage';

  await db
    .insert(analyticsRollupDaily)
    .values({
      id: analyticsRollupDailyId(),
      tenantId: instance.tenantId,
      agentId: instance.agentId,
      instanceId: instance.id,
      model: fact.model,
      bucketDate,
      rollupKey,
      turnCount,
      failedTurnCount,
      toolCallCount,
      toolErrorCount,
      inputTokens: countTokens ? fact.inputTokens : 0,
      outputTokens: countTokens ? fact.outputTokens : 0,
      cacheReadTokens: countTokens ? fact.cacheReadTokens : 0,
      cacheWriteTokens: countTokens ? fact.cacheWriteTokens : 0,
      thinkingTokens: countTokens ? fact.thinkingTokens : 0,
    })
    .onConflictDoUpdate({
      target: analyticsRollupDaily.rollupKey,
      set: {
        turnCount: sql`${analyticsRollupDaily.turnCount} + ${turnCount}`,
        failedTurnCount: sql`${analyticsRollupDaily.failedTurnCount} + ${failedTurnCount}`,
        toolCallCount: sql`${analyticsRollupDaily.toolCallCount} + ${toolCallCount}`,
        toolErrorCount: sql`${analyticsRollupDaily.toolErrorCount} + ${toolErrorCount}`,
        inputTokens: sql`${analyticsRollupDaily.inputTokens} + ${countTokens ? fact.inputTokens : 0}`,
        outputTokens: sql`${analyticsRollupDaily.outputTokens} + ${countTokens ? fact.outputTokens : 0}`,
        cacheReadTokens: sql`${analyticsRollupDaily.cacheReadTokens} + ${countTokens ? fact.cacheReadTokens : 0}`,
        cacheWriteTokens: sql`${analyticsRollupDaily.cacheWriteTokens} + ${countTokens ? fact.cacheWriteTokens : 0}`,
        thinkingTokens: sql`${analyticsRollupDaily.thinkingTokens} + ${countTokens ? fact.thinkingTokens : 0}`,
        updatedAt: sql`now()`,
      },
    });
}

function analyticsEventId(): string {
  return `ane_${randomBytes(16).toString('hex')}`;
}

function analyticsRollupDailyId(): string {
  return `ard_${randomBytes(16).toString('hex')}`;
}
