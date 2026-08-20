// Persistence for the one webhook-triggers product table, kept apart
// from route wiring the same way `@corbits/chat`'s `store.ts` is: the
// HTTP layer never touches drizzle directly, and `WebhookTriggerStore`
// is the seam both route modules actually depend on, so each is
// testable with a plain in-memory fake.
//
// The signing secret is encrypted at rest through Interchange's
// `CredentialCipher` seam (`@intx/types`) — the same seam
// `vendor/intx/hub-api`'s credential/model-provider/oauth-client routes
// use. `createDrizzleWebhookTriggerStore` encrypts on `create` and
// `rotateSecret`, and decrypts on `get`/`getById`, so every other
// module in this package (`management-routes.ts`, `ingress-routes.ts`,
// their tests) keeps seeing a plaintext `secret` on a `WebhookTriggerRow`
// exactly as before — only what actually lands on disk changed. The
// `credentialAad` binding is `["credential-secret", triggerId, "secret"]`,
// so a ciphertext copied onto a different trigger row fails to decrypt
// rather than silently decrypting under the wrong identity.
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { credentialAad, type CredentialCipher } from "@intx/types";

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
>(
  db: WebhookTriggersDb<TSchema>,
  credentialCipher: CredentialCipher,
): WebhookTriggerStore {
  async function decrypted(row: WebhookTriggerRow): Promise<WebhookTriggerRow> {
    const secret = await credentialCipher.decrypt(
      row.secret,
      credentialAad(row.id, "secret"),
    );
    return { ...row, secret };
  }

  return {
    async create(input) {
      const encryptedSecret = await credentialCipher.encrypt(
        input.secret,
        credentialAad(input.id, "secret"),
      );
      const [row] = await db
        .insert(webhookTrigger)
        .values({
          id: input.id,
          tenantId: input.tenantId,
          name: input.name,
          workflowDefinitionId: input.workflowDefinitionId,
          inputTemplate: input.inputTemplate,
          secret: encryptedSecret,
          enabled: true,
          createdBy: input.createdBy,
        })
        .returning();
      if (row === undefined) {
        throw new Error("webhook trigger insert returned no row");
      }
      // The plaintext is already known here (the caller just generated
      // it) — return it directly rather than round-tripping through an
      // extra decrypt call.
      return { ...row, secret: input.secret };
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
      return row !== undefined ? decrypted(row) : undefined;
    },

    async getById(triggerId) {
      const [row] = await db
        .select()
        .from(webhookTrigger)
        .where(eq(webhookTrigger.id, triggerId));
      return row !== undefined ? decrypted(row) : undefined;
    },

    async list(tenantId) {
      // Never decrypted: `publicView` (management-routes.ts) never reads
      // `secret` off a listed row, so paying for N decrypts here would be
      // pure waste.
      return db
        .select()
        .from(webhookTrigger)
        .where(eq(webhookTrigger.tenantId, tenantId));
    },

    async rotateSecret(tenantId, triggerId, secret) {
      const encryptedSecret = await credentialCipher.encrypt(
        secret,
        credentialAad(triggerId, "secret"),
      );
      const [row] = await db
        .update(webhookTrigger)
        .set({ secret: encryptedSecret })
        .where(
          and(
            eq(webhookTrigger.id, triggerId),
            eq(webhookTrigger.tenantId, tenantId),
          ),
        )
        .returning();
      // As in `create`, the plaintext is already known — return it
      // directly instead of decrypting what was just encrypted.
      return row !== undefined ? { ...row, secret } : undefined;
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
