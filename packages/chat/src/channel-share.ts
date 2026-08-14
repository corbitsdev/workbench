// Slack-Connect-style channel projection: a channel owned by one tenant
// (bench) projected into another, gated by bilateral federation trust
// (see `./federation-trust.ts`) and, within the projected tenant, by an
// explicit per-principal membership list its own admins maintain (see
// `channel_share_member` in `./schema.ts`). Mirrors `channel-tenancy.ts`'s
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
import { channelShare, channelShareMember } from "./schema";
import type { FederationTrustStore } from "./federation-trust";

export type ChannelShareDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export interface ChannelShareRow {
  readonly owningTenantId: string;
  readonly channelId: string;
  readonly projectedTenantId: string;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface CreateShareInput {
  readonly owningTenantId: string;
  readonly channelId: string;
  readonly projectedTenantId: string;
  readonly createdBy: string;
}

export type CreateShareOutcome =
  | { readonly kind: "created"; readonly row: ChannelShareRow }
  | { readonly kind: "already_shared" }
  | { readonly kind: "trust_missing" };

export interface AddShareMemberInput {
  readonly projectedTenantId: string;
  readonly channelId: string;
  readonly principalId: string;
  readonly addedBy: string;
}

export interface ChannelShareStoreDeps {
  readonly trust: Pick<FederationTrustStore, "hasBilateralTrust">;
}

export interface ChannelShareStore {
  /**
   * Checks `trust.hasBilateralTrust(owningTenantId, projectedTenantId)`
   * FIRST — `"trust_missing"` is returned, and no row is ever inserted,
   * when it fails. `"already_shared"` for a repeat on the same
   * `(channelId, projectedTenantId)` pair, never a silent overwrite of
   * `createdBy`.
   */
  createShare(input: CreateShareInput): Promise<CreateShareOutcome>;

  /** True iff a row was deleted. Revoking a share never touches trust,
   * and revoking trust (see `./federation-trust.ts`) never cascades
   * here — the two are independent, documented in `docs/TENANCY.md`. */
  revokeShare(
    owningTenantId: string,
    channelId: string,
    projectedTenantId: string,
  ): Promise<boolean>;

  listSharesForChannel(
    owningTenantId: string,
    channelId: string,
  ): Promise<readonly ChannelShareRow[]>;

  listSharesProjectedInto(
    projectedTenantId: string,
  ): Promise<readonly ChannelShareRow[]>;

  getShare(
    channelId: string,
    projectedTenantId: string,
  ): Promise<ChannelShareRow | undefined>;

  /** `"no_share"` — never seeded — when no `channel_share` row exists
   * for `(channelId, projectedTenantId)`. */
  addShareMember(input: AddShareMemberInput): Promise<"added" | "no_share">;

  removeShareMember(
    projectedTenantId: string,
    channelId: string,
    principalId: string,
  ): Promise<boolean>;

  listShareMembers(
    projectedTenantId: string,
    channelId: string,
  ): Promise<readonly string[]>;

  isShareMember(
    projectedTenantId: string,
    channelId: string,
    principalId: string,
  ): Promise<boolean>;
}

/**
 * The production `ChannelShareStore`, operating on this package's own
 * `channel_share`/`channel_share_member` tables (see `./schema.ts`).
 */
export function createDrizzleChannelShareStore<
  TSchema extends Record<string, unknown>,
>(db: ChannelShareDb<TSchema>, deps: ChannelShareStoreDeps): ChannelShareStore {
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
        .from(channelShare)
        .where(
          and(
            eq(channelShare.channelId, input.channelId),
            eq(channelShare.projectedTenantId, input.projectedTenantId),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        return { kind: "already_shared" };
      }

      const now = new Date();
      const [row] = await db
        .insert(channelShare)
        .values({
          owningTenantId: input.owningTenantId,
          channelId: input.channelId,
          projectedTenantId: input.projectedTenantId,
          createdBy: input.createdBy,
          createdAt: now,
        })
        .returning();
      if (row === undefined) {
        throw new Error(
          `channel_share insert for "${input.channelId}" -> ` +
            `"${input.projectedTenantId}" returned no row`,
        );
      }
      return { kind: "created", row };
    },

    async revokeShare(owningTenantId, channelId, projectedTenantId) {
      const deleted = await db
        .delete(channelShare)
        .where(
          and(
            eq(channelShare.owningTenantId, owningTenantId),
            eq(channelShare.channelId, channelId),
            eq(channelShare.projectedTenantId, projectedTenantId),
          ),
        )
        .returning({ channelId: channelShare.channelId });
      return deleted.length > 0;
    },

    async listSharesForChannel(owningTenantId, channelId) {
      return db
        .select()
        .from(channelShare)
        .where(
          and(
            eq(channelShare.owningTenantId, owningTenantId),
            eq(channelShare.channelId, channelId),
          ),
        );
    },

    async listSharesProjectedInto(projectedTenantId) {
      return db
        .select()
        .from(channelShare)
        .where(eq(channelShare.projectedTenantId, projectedTenantId));
    },

    async getShare(channelId, projectedTenantId) {
      const [row] = await db
        .select()
        .from(channelShare)
        .where(
          and(
            eq(channelShare.channelId, channelId),
            eq(channelShare.projectedTenantId, projectedTenantId),
          ),
        )
        .limit(1);
      return row;
    },

    async addShareMember(input) {
      const share = await db
        .select({ channelId: channelShare.channelId })
        .from(channelShare)
        .where(
          and(
            eq(channelShare.channelId, input.channelId),
            eq(channelShare.projectedTenantId, input.projectedTenantId),
          ),
        )
        .limit(1);
      if (share.length === 0) return "no_share";

      await db
        .insert(channelShareMember)
        .values({
          projectedTenantId: input.projectedTenantId,
          channelId: input.channelId,
          principalId: input.principalId,
          addedBy: input.addedBy,
          addedAt: new Date(),
        })
        .onConflictDoNothing();
      return "added";
    },

    async removeShareMember(projectedTenantId, channelId, principalId) {
      const deleted = await db
        .delete(channelShareMember)
        .where(
          and(
            eq(channelShareMember.projectedTenantId, projectedTenantId),
            eq(channelShareMember.channelId, channelId),
            eq(channelShareMember.principalId, principalId),
          ),
        )
        .returning({ principalId: channelShareMember.principalId });
      return deleted.length > 0;
    },

    async listShareMembers(projectedTenantId, channelId) {
      const rows = await db
        .select({ principalId: channelShareMember.principalId })
        .from(channelShareMember)
        .where(
          and(
            eq(channelShareMember.projectedTenantId, projectedTenantId),
            eq(channelShareMember.channelId, channelId),
          ),
        );
      return rows.map((row) => row.principalId);
    },

    async isShareMember(projectedTenantId, channelId, principalId) {
      const rows = await db
        .select({ principalId: channelShareMember.principalId })
        .from(channelShareMember)
        .where(
          and(
            eq(channelShareMember.projectedTenantId, projectedTenantId),
            eq(channelShareMember.channelId, channelId),
            eq(channelShareMember.principalId, principalId),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
  };
}

/**
 * An in-memory `ChannelShareStore`, for tests and any host wiring chat
 * routes without a database. Shares the exact same fail-closed contract
 * as the drizzle store — both checked against `deps.trust`, not a
 * separately-maintained in-memory trust fact.
 */
export function createInMemoryChannelShareStore(
  deps: ChannelShareStoreDeps,
): ChannelShareStore {
  const sharesByKey = new Map<string, ChannelShareRow>();
  const membersByShare = new Map<string, Set<string>>();

  const shareKey = (channelId: string, projectedTenantId: string) =>
    `${channelId}::${projectedTenantId}`;

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
      const key = shareKey(input.channelId, input.projectedTenantId);
      if (sharesByKey.has(key)) {
        return { kind: "already_shared" };
      }
      const row: ChannelShareRow = {
        owningTenantId: input.owningTenantId,
        channelId: input.channelId,
        projectedTenantId: input.projectedTenantId,
        createdBy: input.createdBy,
        createdAt: new Date(),
      };
      sharesByKey.set(key, row);
      return { kind: "created", row };
    },

    async revokeShare(owningTenantId, channelId, projectedTenantId) {
      const key = shareKey(channelId, projectedTenantId);
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

    async listSharesForChannel(owningTenantId, channelId) {
      return [...sharesByKey.values()].filter(
        (row) =>
          row.owningTenantId === owningTenantId && row.channelId === channelId,
      );
    },

    async listSharesProjectedInto(projectedTenantId) {
      return [...sharesByKey.values()].filter(
        (row) => row.projectedTenantId === projectedTenantId,
      );
    },

    async getShare(channelId, projectedTenantId) {
      return sharesByKey.get(shareKey(channelId, projectedTenantId));
    },

    async addShareMember(input) {
      const key = shareKey(input.channelId, input.projectedTenantId);
      if (!sharesByKey.has(key)) return "no_share";
      let members = membersByShare.get(key);
      if (members === undefined) {
        members = new Set();
        membersByShare.set(key, members);
      }
      members.add(input.principalId);
      return "added";
    },

    async removeShareMember(projectedTenantId, channelId, principalId) {
      const members = membersByShare.get(
        shareKey(channelId, projectedTenantId),
      );
      if (members === undefined) return false;
      return members.delete(principalId);
    },

    async listShareMembers(projectedTenantId, channelId) {
      const members = membersByShare.get(
        shareKey(channelId, projectedTenantId),
      );
      return members === undefined ? [] : [...members];
    },

    async isShareMember(projectedTenantId, channelId, principalId) {
      return (
        membersByShare
          .get(shareKey(channelId, projectedTenantId))
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
