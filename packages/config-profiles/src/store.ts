// Persistence for the one config-profiles table, kept apart from route
// wiring the same way `@corbits/routines`' `store.ts` separates
// persistence from `routes.ts`. `ConfigProfileStore` is the seam the
// route layer (and `apply.ts`/`capture.ts`) depend on; `createDrizzleConfigProfileStore`
// is its one production implementation, over the table in `./schema.ts`.
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { type } from "arktype";
import { generateId } from "@intx/hub-common";

import { configProfile } from "./schema";

export type ConfigProfileDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

/**
 * One ordered fallback-list entry: which provider/model pair to place at
 * this position, and whether it should be restricted (disabled) once
 * applied. Order in the array IS the fallback priority — see `apply.ts`.
 */
export type ConfigProfileEntry = {
  readonly provider: string;
  readonly model: string;
  readonly disabled?: boolean;
};

/** Parses `entries` jsonb read back out of the `config_profiles.profile`
 * table (see `./schema.ts`) — the DB is untrusted the same as any other
 * external boundary, so a row's `entries` column is arktype-parsed on the
 * way out rather than `as`-cast, and a malformed row fails loud instead of
 * silently masquerading as a well-formed `ConfigProfileEntry[]`. */
export const ConfigProfileEntrySchema = type({
  provider: "string",
  model: "string",
  "disabled?": "boolean",
});
const ConfigProfileEntriesSchema = ConfigProfileEntrySchema.array();

function parseEntries(raw: unknown): ConfigProfileEntry[] {
  const parsed = ConfigProfileEntriesSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `config profile row has malformed entries: ${parsed.summary}`,
    );
  }
  return parsed;
}

export interface ConfigProfileRow {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description: string | null;
  readonly entries: readonly ConfigProfileEntry[];
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateConfigProfileInput {
  readonly tenantId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly entries: readonly ConfigProfileEntry[];
  readonly createdBy: string;
}

export interface UpdateConfigProfileInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly entries?: readonly ConfigProfileEntry[];
}

export interface ConfigProfileStore {
  createProfile(input: CreateConfigProfileInput): Promise<ConfigProfileRow>;
  getProfile(
    tenantId: string,
    profileId: string,
  ): Promise<ConfigProfileRow | undefined>;
  listProfiles(tenantId: string): Promise<ConfigProfileRow[]>;
  updateProfile(
    tenantId: string,
    profileId: string,
    patch: UpdateConfigProfileInput,
  ): Promise<ConfigProfileRow>;
  deleteProfile(tenantId: string, profileId: string): Promise<boolean>;
}

function mapRow(row: typeof configProfile.$inferSelect): ConfigProfileRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description,
    entries: parseEntries(row.entries),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Package-owned rows have no `IDKind` of their own in
// `@intx/hub-common`'s `PREFIXES` (vendor-owned, read-only) —
// `@corbits/webhook-triggers`' `management-routes.ts` and `launch.ts`
// already reuse `generateId("workflowRun")` as a generic random-id mint
// for exactly this reason, and this store follows the same precedent
// rather than inventing a second id-generation scheme.
function newProfileId(): string {
  return generateId("workflowRun");
}

export function createDrizzleConfigProfileStore<
  TSchema extends Record<string, unknown>,
>(db: ConfigProfileDb<TSchema>): ConfigProfileStore {
  return {
    async createProfile(input) {
      const now = new Date();
      const [row] = await db
        .insert(configProfile)
        .values({
          id: newProfileId(),
          tenantId: input.tenantId,
          name: input.name,
          description: input.description ?? null,
          entries: input.entries,
          createdBy: input.createdBy,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (row === undefined) {
        throw new Error("createProfile: insert returned no row");
      }
      return mapRow(row);
    },

    async getProfile(tenantId, profileId) {
      const [row] = await db
        .select()
        .from(configProfile)
        .where(
          and(
            eq(configProfile.tenantId, tenantId),
            eq(configProfile.id, profileId),
          ),
        )
        .limit(1);
      return row === undefined ? undefined : mapRow(row);
    },

    async listProfiles(tenantId) {
      const rows = await db
        .select()
        .from(configProfile)
        .where(eq(configProfile.tenantId, tenantId));
      return rows.map(mapRow);
    },

    async updateProfile(tenantId, profileId, patch) {
      const [row] = await db
        .update(configProfile)
        .set({ ...patch, updatedAt: new Date() })
        .where(
          and(
            eq(configProfile.tenantId, tenantId),
            eq(configProfile.id, profileId),
          ),
        )
        .returning();
      if (row === undefined) {
        throw new Error(`updateProfile: no profile row for id ${profileId}`);
      }
      return mapRow(row);
    },

    async deleteProfile(tenantId, profileId) {
      const deleted = await db
        .delete(configProfile)
        .where(
          and(
            eq(configProfile.tenantId, tenantId),
            eq(configProfile.id, profileId),
          ),
        )
        .returning();
      return deleted.length > 0;
    },
  };
}

/**
 * An in-memory `ConfigProfileStore`, for tests and any host that wants
 * config-profile routes without a database. Not a supported deployment
 * target.
 */
export function createInMemoryConfigProfileStore(): ConfigProfileStore {
  const rows = new Map<string, ConfigProfileRow>();

  return {
    async createProfile(input) {
      const now = new Date();
      const row: ConfigProfileRow = {
        id: newProfileId(),
        tenantId: input.tenantId,
        name: input.name,
        description: input.description ?? null,
        entries: input.entries,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return row;
    },

    async getProfile(tenantId, profileId) {
      const row = rows.get(profileId);
      return row?.tenantId === tenantId ? row : undefined;
    },

    async listProfiles(tenantId) {
      return [...rows.values()].filter((row) => row.tenantId === tenantId);
    },

    async updateProfile(tenantId, profileId, patch) {
      const existing = rows.get(profileId);
      if (existing === undefined || existing.tenantId !== tenantId) {
        throw new Error(`updateProfile: no profile row for id ${profileId}`);
      }
      const updated: ConfigProfileRow = {
        ...existing,
        ...patch,
        updatedAt: new Date(),
      };
      rows.set(profileId, updated);
      return updated;
    },

    async deleteProfile(tenantId, profileId) {
      const existing = rows.get(profileId);
      if (existing === undefined || existing.tenantId !== tenantId) {
        return false;
      }
      rows.delete(profileId);
      return true;
    },
  };
}
