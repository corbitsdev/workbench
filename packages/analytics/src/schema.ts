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
} from "drizzle-orm/pg-core";

// CL-2670 workflow analytics FACTS. Flat, append-only, REBUILDABLE derived facts
// for insights (duration / step-type / outcome), projected from a terminal run's
// native git event log. These are a pure derived cache — never a run-state mirror
// and never the DAG. The log is always the source of truth; a reproject rebuilds
// every row from scratch.
export const workflowRunFactOutcomes = [
  "completed",
  "failed",
  "cancelled",
] as const;
export const workflowStepFactKinds = [
  "human",
  "agent",
  "deterministic",
  "inline",
  "other",
] as const;

// One row per terminal run. Outcome + wall-clock duration, keyed by runId.
export const workflowRunFact = pgTable(
  "workflow_run_fact",
  {
    runId: text("run_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(),
    outcome: text("outcome", { enum: workflowRunFactOutcomes }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMs: bigint("duration_ms", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("workflow_run_fact_tenant_kind_idx").on(t.tenantId, t.kind)],
);

// One row per terminal step of a terminal run, keyed by (runId, stepId, attempt).
// Re-projecting a run replaces its step facts, so the key is idempotent.
export const workflowStepFact = pgTable(
  "workflow_step_fact",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    stepId: text("step_id").notNull(),
    attempt: integer("attempt").notNull(),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(),
    stepKind: text("step_kind", { enum: workflowStepFactKinds }).notNull(),
    outcome: text("outcome", { enum: workflowRunFactOutcomes }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMs: bigint("duration_ms", { mode: "number" }),
    // awaitSignal gate wait: SignalAwaited.at → SignalReceived.at. Null for
    // non-gate steps.
    gateWaitMs: bigint("gate_wait_ms", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("workflow_step_fact_run_step_attempt").on(
      t.runId,
      t.stepId,
      t.attempt,
    ),
    // Aggregation by (tenant, kind, stepKind) — the insights query's group key.
    index("workflow_step_fact_tenant_kind_stepkind_idx").on(
      t.tenantId,
      t.kind,
      t.stepKind,
    ),
    index("workflow_step_fact_run_idx").on(t.runId),
  ],
);

export const analyticsEvent = pgTable(
  "analytics_event",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id"),
    agentId: text("agent_id"),
    instanceId: text("instance_id"),
    sessionId: text("session_id"),
    toolCallId: text("tool_call_id"),
    eventKey: text("event_key").notNull(),
    eventType: text("event_type", {
      enum: [
        "inference_usage",
        "inference_done",
        "inference_error",
        "tool_call",
        "turn_completed",
        "turn_failed",
        "compaction",
      ],
    }).notNull(),
    model: text("model"),
    status: text("status", {
      enum: ["running", "completed", "failed", "error"],
    }),
    inputTokens: bigint("input_tokens", { mode: "number" })
      .notNull()
      .default(0),
    outputTokens: bigint("output_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" })
      .notNull()
      .default(0),
    thinkingTokens: bigint("thinking_tokens", { mode: "number" })
      .notNull()
      .default(0),
    source: jsonb("source"),
    metadata: jsonb("metadata"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("analytics_event_event_key").on(t.eventKey),
    // Secondary indexes deferred: analytics_event is append-only and high-write.
    // getCacheBaseline (queries.ts, CL-2686) is the FIRST raw-fact reader
    // (tenant_id + event_type filter, occurred_at range, group by agent_id) —
    // today a low-frequency operator/diagnostic endpoint, so a seq-scan is
    // acceptable at current scale. Before CL-2687's cost dashboard drives real
    // traffic, add a (tenant_id, occurred_at) index — but analytics_event is
    // write-hot, so build it off-peak / non-blocking (a plain CREATE INDEX
    // locks writes; cf. the CL-2490 hot-table lesson). Tracked as a follow-up.
  ],
);

export const analyticsRollupDaily = pgTable(
  "analytics_rollup_daily",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    agentId: text("agent_id"),
    instanceId: text("instance_id"),
    model: text("model"),
    bucketDate: date("bucket_date").notNull(),
    rollupKey: text("rollup_key").notNull(),
    turnCount: integer("turn_count").notNull().default(0),
    failedTurnCount: integer("failed_turn_count").notNull().default(0),
    toolCallCount: integer("tool_call_count").notNull().default(0),
    toolErrorCount: integer("tool_error_count").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" })
      .notNull()
      .default(0),
    outputTokens: bigint("output_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" })
      .notNull()
      .default(0),
    thinkingTokens: bigint("thinking_tokens", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("analytics_rollup_daily_rollup_key").on(t.rollupKey),
    // Primary read path: tenant summary (all agents, optional date range).
    index("analytics_rollup_daily_tenant_bucket_idx").on(
      t.tenantId,
      t.bucketDate,
    ),
    // Per-agent breakdown: "how much is Myra costing" queries.
    index("analytics_rollup_daily_tenant_agent_bucket_idx").on(
      t.tenantId,
      t.agentId,
      t.bucketDate,
    ),
    // Per-instance queries.
    index("analytics_rollup_daily_instance_bucket_idx").on(
      t.instanceId,
      t.bucketDate,
    ),
  ],
);
