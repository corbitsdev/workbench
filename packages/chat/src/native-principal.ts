import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { principal } from "@intx/db/schema";

export interface NativePrincipal {
  readonly id: string;
  readonly kind: "user" | "agent" | "workflow";
  readonly status: "active" | "suspended" | "invited" | "deactivated";
  readonly refId: string;
}

export interface NativePrincipalStore {
  getTenantPrincipal(
    tenantId: string,
    principalId: string,
  ): Promise<NativePrincipal | undefined>;
}

export function createDrizzleNativePrincipalStore<
  TSchema extends Record<string, unknown>,
>(db: PostgresJsDatabase<TSchema>): NativePrincipalStore {
  return {
    async getTenantPrincipal(tenantId, principalId) {
      const [row] = await db
        .select({
          id: principal.id,
          kind: principal.kind,
          status: principal.status,
          refId: principal.refId,
        })
        .from(principal)
        .where(
          and(eq(principal.tenantId, tenantId), eq(principal.id, principalId)),
        )
        .limit(1);
      return row;
    },
  };
}

export function createInMemoryNativePrincipalStore(): NativePrincipalStore & {
  registerPrincipal(tenantId: string, value: NativePrincipal): void;
} {
  const principals = new Map<string, NativePrincipal>();
  const key = (tenantId: string, principalId: string) =>
    `${tenantId}\u0000${principalId}`;

  return {
    registerPrincipal(tenantId, value) {
      principals.set(key(tenantId, value.id), value);
    },
    async getTenantPrincipal(tenantId, principalId) {
      return principals.get(key(tenantId, principalId));
    },
  };
}
