// Slack-Connect-style workbench projection: a workbench owned by one tenant
// (bench) projected into another, gated by bilateral federation trust
// (see `./federation-trust.ts`) and, within the projected tenant, by an
// explicit per-principal membership list its own admins maintain (see
// `workbench_share_member` in `./schema.ts`). Mirrors `workbench-tenancy.ts`'s
// shape: a store interface, a drizzle implementation, and an in-memory
// test double.
//
// Both write paths here are deliberately fail-closed: `createShare` never
// inserts a row without bilateral trust (checked first, inside the same
// call), and `addShareMember` never seeds a membership row for a share
// that doesn't exist. Neither check is re-verified by a caller elsewhere
// — this store is the one place either fact is asserted.
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { workbenchShare, workbenchShareMember } from "./schema";
import type { FederationTrustStore } from "./federation-trust";

export type WorkbenchShareDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export interface WorkbenchShareRow {
  readonly owningTenantId: string;
  readonly workbenchId: string;
  readonly projectedTenantId: string;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface CreateShareInput {
  readonly owningTenantId: string;
  readonly workbenchId: string;
  readonly projectedTenantId: string;
  readonly createdBy: string;
}

export type CreateShareOutcome =
  | { readonly kind: "created"; readonly row: WorkbenchShareRow }
  | { readonly kind: "already_shared" }
  | { readonly kind: "trust_missing" };

export interface AddShareMemberInput {
  readonly projectedTenantId: string;
  readonly workbenchId: string;
  readonly principalId: string;
  readonly addedBy: string;
}

export interface WorkbenchShareStoreDeps {
  readonly trust: Pick<FederationTrustStore, "hasBilateralTrust">;
}

export interface WorkbenchShareStore {
  /**
   * Checks `trust.hasBilateralTrust(owningTenantId, projectedTenantId)`
   * FIRST — `"trust_missing"` is returned, and no row is ever inserted,
   * when it fails. `"already_shared"` for a repeat on the same
   * `(workbenchId, projectedTenantId)` pair, never a silent overwrite of
   * `createdBy`.
   */
  createShare(input: CreateShareInput): Promise<CreateShareOutcome>;

  /** True iff a row was deleted. Revoking a share never touches trust,
   * and revoking trust (see `./federation-trust.ts`) never cascades
   * here — the two are independent, documented in `docs/TENANCY.md`. */
  revokeShare(
    owningTenantId: string,
    workbenchId: string,
    projectedTenantId: string,
  ): Promise<boolean>;

  listSharesForWorkbench(
    owningTenantId: string,
    workbenchId: string,
  ): Promise<readonly WorkbenchShareRow[]>;

  listSharesProjectedInto(
    projectedTenantId: string,
  ): Promise<readonly WorkbenchShareRow[]>;

  getShare(
    workbenchId: string,
    projectedTenantId: string,
  ): Promise<WorkbenchShareRow | undefined>;

  /** `"no_share"` — never seeded — when no `workbench_share` row exists
   * for `(workbenchId, projectedTenantId)`. */
  addShareMember(input: AddShareMemberInput): Promise<"added" | "no_share">;

  removeShareMember(
    projectedTenantId: string,
    workbenchId: string,
    principalId: string,
  ): Promise<boolean>;

  listShareMembers(
    projectedTenantId: string,
    workbenchId: string,
  ): Promise<readonly string[]>;

  isShareMember(
    projectedTenantId: string,
    workbenchId: string,
    principalId: string,
  ): Promise<boolean>;
}

/**
 * The production `WorkbenchShareStore`, operating on this package's own
 * `workbench_share`/`workbench_share_member` tables (see `./schema.ts`).
 */
export function createDrizzleWorkbenchShareStore<
  TSchema extends Record<string, unknown>,
>(
  db: WorkbenchShareDb<TSchema>,
  deps: WorkbenchShareStoreDeps,
): WorkbenchShareStore {
  return {
    async createShare(input) {
      if (
        !(await deps.trust.hasBilateralTrust(
          input.owningTenantId,
          input.projectedTenantId,
        ))
      ) {
        return { kind: "trust_missing" };
      }

      const existing = await db
        .select()
        .from(workbenchShare)
        .where(
          and(
            eq(workbenchShare.workbenchId, input.workbenchId),
            eq(workbenchShare.projectedTenantId, input.projectedTenantId),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        return { kind: "already_shared" };
      }

      const now = new Date();
      const [row] = await db
        .insert(workbenchShare)
        .values({
          owningTenantId: input.owningTenantId,
          workbenchId: input.workbenchId,
          projectedTenantId: input.projectedTenantId,
          createdBy: input.createdBy,
          createdAt: now,
        })
        .returning();
      if (row === undefined) {
        throw new Error(
          `workbench_share insert for "${input.workbenchId}" -> ` +
            `"${input.projectedTenantId}" returned no row`,
        );
      }
      return { kind: "created", row };
    },

    async revokeShare(owningTenantId, workbenchId, projectedTenantId) {
      const deleted = await db
        .delete(workbenchShare)
        .where(
          and(
            eq(workbenchShare.owningTenantId, owningTenantId),
            eq(workbenchShare.workbenchId, workbenchId),
            eq(workbenchShare.projectedTenantId, projectedTenantId),
          ),
        )
        .returning({ workbenchId: workbenchShare.workbenchId });
      return deleted.length > 0;
    },

    async listSharesForWorkbench(owningTenantId, workbenchId) {
      return db
        .select()
        .from(workbenchShare)
        .where(
          and(
            eq(workbenchShare.owningTenantId, owningTenantId),
            eq(workbenchShare.workbenchId, workbenchId),
          ),
        );
    },

    async listSharesProjectedInto(projectedTenantId) {
      return db
        .select()
        .from(workbenchShare)
        .where(eq(workbenchShare.projectedTenantId, projectedTenantId));
    },

    async getShare(workbenchId, projectedTenantId) {
      const [row] = await db
        .select()
        .from(workbenchShare)
        .where(
          and(
            eq(workbenchShare.workbenchId, workbenchId),
            eq(workbenchShare.projectedTenantId, projectedTenantId),
          ),
        )
        .limit(1);
      return row;
    },

    async addShareMember(input) {
      const share = await db
        .select({ workbenchId: workbenchShare.workbenchId })
        .from(workbenchShare)
        .where(
          and(
            eq(workbenchShare.workbenchId, input.workbenchId),
            eq(workbenchShare.projectedTenantId, input.projectedTenantId),
          ),
        )
        .limit(1);
      if (share.length === 0) return "no_share";

      await db
        .insert(workbenchShareMember)
        .values({
          projectedTenantId: input.projectedTenantId,
          workbenchId: input.workbenchId,
          principalId: input.principalId,
          addedBy: input.addedBy,
          addedAt: new Date(),
        })
        .onConflictDoNothing();
      return "added";
    },

    async removeShareMember(projectedTenantId, workbenchId, principalId) {
      const deleted = await db
        .delete(workbenchShareMember)
        .where(
          and(
            eq(workbenchShareMember.projectedTenantId, projectedTenantId),
            eq(workbenchShareMember.workbenchId, workbenchId),
            eq(workbenchShareMember.principalId, principalId),
          ),
        )
        .returning({ principalId: workbenchShareMember.principalId });
      return deleted.length > 0;
    },

    async listShareMembers(projectedTenantId, workbenchId) {
      const rows = await db
        .select({ principalId: workbenchShareMember.principalId })
        .from(workbenchShareMember)
        .where(
          and(
            eq(workbenchShareMember.projectedTenantId, projectedTenantId),
            eq(workbenchShareMember.workbenchId, workbenchId),
          ),
        );
      return rows.map((row) => row.principalId);
    },

    async isShareMember(projectedTenantId, workbenchId, principalId) {
      const rows = await db
        .select({ principalId: workbenchShareMember.principalId })
        .from(workbenchShareMember)
        .where(
          and(
            eq(workbenchShareMember.projectedTenantId, projectedTenantId),
            eq(workbenchShareMember.workbenchId, workbenchId),
            eq(workbenchShareMember.principalId, principalId),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
  };
}

/**
 * An in-memory `WorkbenchShareStore`, for tests and any host wiring chat
 * routes without a database. Shares the exact same fail-closed contract
 * as the drizzle store — both checked against `deps.trust`, not a
 * separately-maintained in-memory trust fact.
 */
export function createInMemoryWorkbenchShareStore(
  deps: WorkbenchShareStoreDeps,
): WorkbenchShareStore {
  const sharesByKey = new Map<string, WorkbenchShareRow>();
  const membersByShare = new Map<string, Set<string>>();

  const shareKey = (workbenchId: string, projectedTenantId: string) =>
    `${workbenchId}::${projectedTenantId}`;

  return {
    async createShare(input) {
      if (
        !(await deps.trust.hasBilateralTrust(
          input.owningTenantId,
          input.projectedTenantId,
        ))
      ) {
        return { kind: "trust_missing" };
      }
      const key = shareKey(input.workbenchId, input.projectedTenantId);
      if (sharesByKey.has(key)) {
        return { kind: "already_shared" };
      }
      const row: WorkbenchShareRow = {
        owningTenantId: input.owningTenantId,
        workbenchId: input.workbenchId,
        projectedTenantId: input.projectedTenantId,
        createdBy: input.createdBy,
        createdAt: new Date(),
      };
      sharesByKey.set(key, row);
      return { kind: "created", row };
    },

    async revokeShare(owningTenantId, workbenchId, projectedTenantId) {
      const key = shareKey(workbenchId, projectedTenantId);
      const existing = sharesByKey.get(key);
      if (
        existing === undefined ||
        existing.owningTenantId !== owningTenantId
      ) {
        return false;
      }
      sharesByKey.delete(key);
      membersByShare.delete(key);
      return true;
    },

    async listSharesForWorkbench(owningTenantId, workbenchId) {
      return [...sharesByKey.values()].filter(
        (row) =>
          row.owningTenantId === owningTenantId &&
          row.workbenchId === workbenchId,
      );
    },

    async listSharesProjectedInto(projectedTenantId) {
      return [...sharesByKey.values()].filter(
        (row) => row.projectedTenantId === projectedTenantId,
      );
    },

    async getShare(workbenchId, projectedTenantId) {
      return sharesByKey.get(shareKey(workbenchId, projectedTenantId));
    },

    async addShareMember(input) {
      const key = shareKey(input.workbenchId, input.projectedTenantId);
      if (!sharesByKey.has(key)) return "no_share";
      let members = membersByShare.get(key);
      if (members === undefined) {
        members = new Set();
        membersByShare.set(key, members);
      }
      members.add(input.principalId);
      return "added";
    },

    async removeShareMember(projectedTenantId, workbenchId, principalId) {
      const members = membersByShare.get(
        shareKey(workbenchId, projectedTenantId),
      );
      if (members === undefined) return false;
      return members.delete(principalId);
    },

    async listShareMembers(projectedTenantId, workbenchId) {
      const members = membersByShare.get(
        shareKey(workbenchId, projectedTenantId),
      );
      return members === undefined ? [] : [...members];
    },

    async isShareMember(projectedTenantId, workbenchId, principalId) {
      return (
        membersByShare
          .get(shareKey(workbenchId, projectedTenantId))
          ?.has(principalId) ?? false
      );
    },
  };
}

/**
 * Derives a fallback tenant-monogram from a tenant name, mirroring
 * `@corbits/bench-ui`'s `benchMonogram` (`bench-switcher.tsx`) exactly —
 * not imported, since `chat-ui`/`chat` should not gain a `bench-ui`
 * dependency for one small pure function, and this one runs server-side
 * (the branding store CL-5911 introduces doesn't exist yet, so the
 * server computes and sends a monogram rather than the client guessing).
 */
export function monogramFromName(name: string): string {
  const initials = name
    .split(/[\s._-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return initials.length > 0 ? initials : "··";
}
