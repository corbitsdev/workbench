// The binding store: which workbench channel a Slack channel is bound
// to, scoped by tenant (see `./schema.ts`'s header comment for why
// `tenantId` — not a Slack team id — is the isolation boundary).
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { slackChannelBinding, type SlackChannelBindingRow } from "./schema";

function generateBindingId(): string {
  return `scb_${crypto.randomUUID().replaceAll("-", "")}`;
}

export type SlackTagDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export interface SlackChannelBinding {
  readonly tenantId: string;
  readonly slackChannelId: string;
  readonly channelId: string;
  readonly createdAt: Date;
}

export interface CreateSlackChannelBindingInput {
  readonly tenantId: string;
  readonly slackChannelId: string;
  readonly channelId: string;
}

export interface SlackChannelBindingStore {
  getBinding(
    tenantId: string,
    slackChannelId: string,
  ): Promise<SlackChannelBinding | undefined>;

  /**
   * Idempotently records a binding: two concurrent first-contact events
   * for the same Slack channel resolve to the same row rather than
   * throwing on the unique constraint or creating a duplicate — the
   * loser of the race gets the winner's row back.
   */
  createBinding(
    input: CreateSlackChannelBindingInput,
  ): Promise<SlackChannelBinding>;
}

function toBinding(row: SlackChannelBindingRow): SlackChannelBinding {
  return {
    tenantId: row.tenantId,
    slackChannelId: row.slackChannelId,
    channelId: row.channelId,
    createdAt: row.createdAt,
  };
}

export function createDrizzleSlackChannelBindingStore<
  TSchema extends Record<string, unknown>,
>(db: SlackTagDb<TSchema>): SlackChannelBindingStore {
  return {
    async getBinding(tenantId, slackChannelId) {
      const [row] = await db
        .select()
        .from(slackChannelBinding)
        .where(
          and(
            eq(slackChannelBinding.tenantId, tenantId),
            eq(slackChannelBinding.slackChannelId, slackChannelId),
          ),
        )
        .limit(1);
      return row === undefined ? undefined : toBinding(row);
    },

    async createBinding(input) {
      const [row] = await db
        .insert(slackChannelBinding)
        .values({
          id: generateBindingId(),
          tenantId: input.tenantId,
          slackChannelId: input.slackChannelId,
          channelId: input.channelId,
        })
        .onConflictDoNothing({
          target: [
            slackChannelBinding.tenantId,
            slackChannelBinding.slackChannelId,
          ],
        })
        .returning();
      if (row !== undefined) return toBinding(row);

      // Lost the race: another request already inserted this
      // (tenantId, slackChannelId) pair between our insert attempt and
      // now. Read back the winner's row rather than surfacing a
      // conflict to the caller — this call is documented as
      // idempotent.
      const existing = await this.getBinding(
        input.tenantId,
        input.slackChannelId,
      );
      if (existing === undefined) {
        throw new Error(
          `slack-tag: binding for tenant "${input.tenantId}" / Slack channel ` +
            `"${input.slackChannelId}" vanished between insert and read-back`,
        );
      }
      return existing;
    },
  };
}

/**
 * An in-memory `SlackChannelBindingStore`, for tests and any host
 * wiring slack-tag without a database. Mints synthetic ids with the
 * same `generateId` shape as the drizzle store.
 */
export function createInMemorySlackChannelBindingStore(): SlackChannelBindingStore {
  const byKey = new Map<string, SlackChannelBinding>();
  const key = (tenantId: string, slackChannelId: string) =>
    `${tenantId}::${slackChannelId}`;

  return {
    async getBinding(tenantId, slackChannelId) {
      return byKey.get(key(tenantId, slackChannelId));
    },
    async createBinding(input) {
      const existingKey = key(input.tenantId, input.slackChannelId);
      const existing = byKey.get(existingKey);
      if (existing !== undefined) return existing;
      const binding: SlackChannelBinding = {
        tenantId: input.tenantId,
        slackChannelId: input.slackChannelId,
        channelId: input.channelId,
        createdAt: new Date(),
      };
      byKey.set(existingKey, binding);
      return binding;
    },
  };
}
