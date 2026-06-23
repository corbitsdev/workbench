import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

export const analyticsEvent = pgTable(
  'analytics_event',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    principalId: text('principal_id'),
    agentId: text('agent_id'),
    instanceId: text('instance_id'),
    sessionId: text('session_id'),
    toolCallId: text('tool_call_id'),
    eventKey: text('event_key').notNull(),
    eventType: text('event_type', {
      enum: ['inference_usage', 'inference_done', 'tool_call', 'turn_completed', 'turn_failed'],
    }).notNull(),
    model: text('model'),
    toolName: text('tool_name'),
    status: text('status', {
      enum: ['running', 'completed', 'failed', 'error'],
    }),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    thinkingTokens: bigint('thinking_tokens', { mode: 'number' }).notNull().default(0),
    source: jsonb('source'),
    metadata: jsonb('metadata'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('analytics_event_event_key').on(t.eventKey),
    index('analytics_event_tenant_occurred_at_idx').on(t.tenantId, t.occurredAt),
    index('analytics_event_instance_occurred_at_idx').on(t.instanceId, t.occurredAt),
  ]
);

export const analyticsRollupDaily = pgTable(
  'analytics_rollup_daily',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    agentId: text('agent_id'),
    instanceId: text('instance_id'),
    model: text('model'),
    bucketDate: date('bucket_date').notNull(),
    rollupKey: text('rollup_key').notNull(),
    turnCount: integer('turn_count').notNull().default(0),
    failedTurnCount: integer('failed_turn_count').notNull().default(0),
    toolCallCount: integer('tool_call_count').notNull().default(0),
    toolErrorCount: integer('tool_error_count').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    thinkingTokens: bigint('thinking_tokens', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('analytics_rollup_daily_rollup_key').on(t.rollupKey),
    index('analytics_rollup_daily_tenant_bucket_idx').on(t.tenantId, t.bucketDate),
    index('analytics_rollup_daily_instance_bucket_idx').on(t.instanceId, t.bucketDate),
  ]
);
