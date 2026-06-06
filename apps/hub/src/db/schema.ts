import {
  type AnyPgColumn,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const severity = ['low', 'medium', 'high', 'critical'] as const;
export const artifactStatus = ['draft', 'approved', 'rejected'] as const;
export const transcriptSource = ['paste', 'granola'] as const;

export const transcript = pgTable('transcript', {
  id: uuid('id').primaryKey().defaultRandom(),
  content: text('content').notNull(),
  source: text('source', { enum: transcriptSource }).notNull().default('paste'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const workflowRun = pgTable('workflow_run', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: text('tenant_id').notNull(),
  principalId: text('principal_id').notNull(),
  kind: text('kind').notNull(),
  status: text('status').notNull(),
  input: jsonb('input').$type<Record<string, unknown>>(),
  output: jsonb('output').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const painPoint = pgTable('pain_point', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => workflowRun.id, { onDelete: 'cascade' }),
  severity: text('severity', { enum: severity }).notNull(),
  context: text('context').notNull(),
  quote: text('quote').notNull(),
  selected: boolean('selected').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// A first-class output of any workflow or agent. `kind` is free-form text
// (validated at the application edge, not a pg enum, so kinds can grow without
// migrations). Nesting via parent_id; provenance via pain_point_id (nullable).
export const artifact = pgTable('artifact', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').references(() => workflowRun.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id').references((): AnyPgColumn => artifact.id, { onDelete: 'cascade' }),
  painPointId: uuid('pain_point_id').references(() => painPoint.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  status: text('status', { enum: artifactStatus }).notNull().default('draft'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// Append-only version history. Every change by an agent or a human writes a row.
// author_id is the actor's principal id (no agent/human distinction).
export const artifactVersion = pgTable('artifact_version', {
  id: uuid('id').primaryKey().defaultRandom(),
  artifactId: uuid('artifact_id')
    .notNull()
    .references(() => artifact.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  authorId: text('author_id').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ─── Approvals ─────────────────────────────────────────────────────

export const approvalStatus = ['pending', 'approved', 'rejected'] as const;

export const approval = pgTable('approval', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: text('tenant_id').notNull(),
  principalId: text('principal_id').notNull(),
  agentId: text('agent_id').notNull(),
  sessionId: text('session_id'),
  resource: text('resource').notNull(),
  action: text('action').notNull(),
  context: jsonb('context').$type<Record<string, unknown>>(),
  status: text('status', { enum: approvalStatus }).notNull().default('pending'),
  message: text('message'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at'),
});
