import type { DB } from "@intx/db";
import { and, eq, inArray } from "drizzle-orm";
import { memberIdentity } from "../db/schema";

export interface IdentityAccount {
  provider: string;
  value: string;
  label: string | null;
  isPrimary: boolean;
  metadata: Record<string, unknown>;
}

export interface SetIdentityInput {
  provider: string;
  value: string;
  label?: string;
  primary?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Read a member's stored tool accounts, optionally narrowed to one or more
 * providers. Primary accounts sort first within a provider so a caller that
 * wants "the" account for a provider can take the head.
 */
export async function getIdentityAccounts(
  db: DB["db"],
  tenantId: string,
  memberPrincipalId: string,
  providers?: string[],
): Promise<IdentityAccount[]> {
  const conditions = [
    eq(memberIdentity.tenantId, tenantId),
    eq(memberIdentity.memberPrincipalId, memberPrincipalId),
  ];
  if (providers !== undefined && providers.length > 0) {
    conditions.push(inArray(memberIdentity.provider, providers));
  }

  const rows = await db
    .select({
      provider: memberIdentity.provider,
      value: memberIdentity.value,
      label: memberIdentity.label,
      isPrimary: memberIdentity.isPrimary,
      metadata: memberIdentity.metadata,
    })
    .from(memberIdentity)
    .where(and(...conditions));

  return rows
    .map((row) => ({
      provider: row.provider,
      value: row.value,
      label: row.label,
      isPrimary: row.isPrimary,
      metadata: row.metadata ?? {},
    }))
    .sort((a, b) => {
      if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
    });
}

/**
 * Upsert one account for a member, keyed by (provider, value). When `primary`
 * is set the account becomes that provider's default and any prior primary for
 * the same provider is cleared, so a provider has at most one primary.
 */
export async function setIdentityAccount(
  db: DB["db"],
  tenantId: string,
  memberPrincipalId: string,
  input: SetIdentityInput,
): Promise<IdentityAccount> {
  const now = new Date();
  const isPrimary = input.primary === true;

  return db.transaction(async (tx) => {
    if (isPrimary) {
      await tx
        .update(memberIdentity)
        .set({ isPrimary: false, updatedAt: now })
        .where(
          and(
            eq(memberIdentity.tenantId, tenantId),
            eq(memberIdentity.memberPrincipalId, memberPrincipalId),
            eq(memberIdentity.provider, input.provider),
          ),
        );
    }

    const [row] = await tx
      .insert(memberIdentity)
      .values({
        tenantId,
        memberPrincipalId,
        provider: input.provider,
        value: input.value,
        label: input.label ?? null,
        isPrimary,
        metadata: input.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          memberIdentity.tenantId,
          memberIdentity.memberPrincipalId,
          memberIdentity.provider,
          memberIdentity.value,
        ],
        set: {
          label: input.label ?? null,
          isPrimary,
          metadata: input.metadata ?? {},
          updatedAt: now,
        },
      })
      .returning({
        provider: memberIdentity.provider,
        value: memberIdentity.value,
        label: memberIdentity.label,
        isPrimary: memberIdentity.isPrimary,
        metadata: memberIdentity.metadata,
      });

    if (!row) throw new Error("Failed to save identity account");
    return {
      provider: row.provider,
      value: row.value,
      label: row.label,
      isPrimary: row.isPrimary,
      metadata: row.metadata ?? {},
    };
  });
}
