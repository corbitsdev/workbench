// Persistence for the one webhook-triggers product table, kept apart
// from route wiring the same way `@corbits/chat`'s `store.ts` is: the
// HTTP layer never touches drizzle directly, and `WebhookTriggerStore`
// is the seam both route modules actually depend on, so each is
// testable with a plain in-memory fake.
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { webhookTrigger, type WebhookTriggerRow } from "./schema";

export type WebhookTriggersDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export interface CreateWebhookTriggerInput {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly workflowDefinitionId: string;
  readonly inputTemplate: string;
  readonly secret: string;
  readonly createdBy: string;
}

export interface WebhookTriggerStore {
  create(input: CreateWebhookTriggerInput): Promise<WebhookTriggerRow>;
  get(
    tenantId: string,
    triggerId: string,
  ): Promise<WebhookTriggerRow | undefined>;
  /** Looked up by the ingress route, which has no tenant scope of its own. */
  getById(triggerId: string): Promise<WebhookTriggerRow | undefined>;
  list(tenantId: string): Promise<WebhookTriggerRow[]>;
  rotateSecret(
    tenantId: string,
    triggerId: string,
    secret: string,
  ): Promise<WebhookTriggerRow | undefined>;
  setEnabled(
    tenantId: string,
    triggerId: string,
    enabled: boolean,
  ): Promise<WebhookTriggerRow | undefined>;
  recordFired(triggerId: string, firedAt: Date): Promise<void>;
  remove(tenantId: string, triggerId: string): Promise<boolean>;
}

export function createDrizzleWebhookTriggerStore<
  TSchema extends Record<string, unknown>,
>(db: WebhookTriggersDb<TSchema>): WebhookTriggerStore {
  return {
    async create(input) {
      const [row] = await db
        .insert(webhookTrigger)
        .values({
          id: input.id,
          tenantId: input.tenantId,
          name: input.name,
          workflowDefinitionId: input.workflowDefinitionId,
          inputTemplate: input.inputTemplate,
          secret: input.secret,
          enabled: true,
          createdBy: input.createdBy,
        })
        .returning();
      if (row === undefined) {
        throw new Error("webhook trigger insert returned no row");
      }
      return row;
    },

    async get(tenantId, triggerId) {
      const [row] = await db
        .select()
        .from(webhookTrigger)
        .where(
          and(
            eq(webhookTrigger.id, triggerId),
            eq(webhookTrigger.tenantId, tenantId),
          ),
        );
      return row;
    },

    async getById(triggerId) {
      const [row] = await db
        .select()
        .from(webhookTrigger)
        .where(eq(webhookTrigger.id, triggerId));
      return row;
    },

    async list(tenantId) {
      return db
        .select()
        .from(webhookTrigger)
        .where(eq(webhookTrigger.tenantId, tenantId));
    },

    async rotateSecret(tenantId, triggerId, secret) {
      const [row] = await db
        .update(webhookTrigger)
        .set({ secret })
        .where(
          and(
            eq(webhookTrigger.id, triggerId),
            eq(webhookTrigger.tenantId, tenantId),
          ),
        )
        .returning();
      return row;
    },

    async setEnabled(tenantId, triggerId, enabled) {
      const [row] = await db
        .update(webhookTrigger)
        .set({ enabled })
        .where(
          and(
            eq(webhookTrigger.id, triggerId),
            eq(webhookTrigger.tenantId, tenantId),
          ),
        )
        .returning();
      return row;
    },

    async recordFired(triggerId, firedAt) {
      await db
        .update(webhookTrigger)
        .set({ lastFiredAt: firedAt })
        .where(eq(webhookTrigger.id, triggerId));
    },

    async remove(tenantId, triggerId) {
      const deleted = await db
        .delete(webhookTrigger)
        .where(
          and(
            eq(webhookTrigger.id, triggerId),
            eq(webhookTrigger.tenantId, tenantId),
          ),
        )
        .returning({ id: webhookTrigger.id });
      return deleted.length > 0;
    },
  };
}
