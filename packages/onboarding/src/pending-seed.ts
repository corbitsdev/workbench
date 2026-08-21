// Server-side custody for a just-connected credential's plaintext key,
// carried from the OAuth callback (which must never wait on a workflow
// deploy — see `complete-credential.ts`) to the onboarding page's own
// follow-up request, the one that actually runs `ensureSeeded`. The
// hub's credential rows are write-only by design (a secret is never
// handed back over `GET /api/tenants/:id/credentials`), so once the
// callback's own request ends, the plaintext key is gone from memory
// unless something carries it forward — this is that something.
//
// CL-6031 moved this off the browser entirely. It used to be an
// HttpOnly cookie sealed the same way the PKCE connect state is
// (`pkce.ts`); a cookie meant the browser briefly custodied a sealed
// copy of the plaintext key even though it could never read it. Now
// it is one row per (userId, tenantId) in this package's own
// `onboarding.pending_seed` table (see `./schema.ts`), and the browser
// carries nothing but its ordinary session cookie — which already
// scopes every read to the exact user and tenant the row was written
// for, the same guarantee the cookie's own userId/tenantId check used
// to provide by hand.
//
// Same AEAD discipline the cookie used: sealed via the shared
// `CredentialCipher`, AAD `["onboarding-pending-seed", provider]`, so a
// value minted moments before a hub restart survives it, and a row
// sealed for one provider cannot decrypt under another's. Unlike the
// PKCE connect state, this is not single-use — the workflow-deploy step
// it feeds (`seedTenant`/`ensureSeeded`) is itself idempotent
// (409-then-list on every create), so two overlapping "finish setup"
// calls both reading the same still-valid row is exactly as safe as
// one, and a legit retry after a transient failure can reuse it within
// the same short window instead of being stranded with no key to retry
// with. A single active row per (userId, tenantId) — writing a new one
// replaces whatever was there (upsert) — mirrors the cookie's
// single-active-token behavior.
//
// TTL is enforced at read time: a row past its `expiresAt` is deleted
// and treated as though it were never there, rather than by a periodic
// sweep job. This is deliberately the simpler of the two designs list
// in the ticket — a stale row is inert until someone reads it (nothing
// else in the system scans this table), and the one real reader
// (`POST /complete-setup`) always reads well inside a user's onboarding
// session, so a row that outlives its ten-minute TTL unread just sits
// there harmlessly until that read finally happens (or never comes,
// in which case it is dead weight, not a correctness or security
// problem — the ciphertext is worthless without the cipher key, and a
// forgotten row does not accumulate: the next OAuth connect upserts
// over it).
//
// Future work: once Interchange ships an `InferenceSource`
// credential-by-reference primitive (the [Intx ask] tracked on this
// ticket), the callback can hand `ensureSeeded` a reference to the
// credential it already just persisted instead of smuggling the
// plaintext key forward at all — this entire store, table, and AEAD
// dance goes away.

import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { type } from "arktype";
import type { CredentialCipher } from "@intx/types";
import {
  supportedCredentialProviders,
  type SupportedCredentialProvider,
} from "@workbench/hub-client";
import { pendingSeed } from "./schema";

/**
 * How long a row stays usable. This is a provisioning queue's durability
 * window, not a handoff token's lifetime (CL-6457): the row is what lets
 * a background drain finish — or, after a hub restart, resume — the
 * workflow deploys that connect deliberately no longer waits on. It is
 * deleted the moment provisioning converges, so this bound only governs
 * a bench that never converged at all: long enough that an overnight
 * sidecar outage still resolves itself, short enough that an abandoned
 * one does not keep a duplicate of the key indefinitely. The key itself
 * already lives on, encrypted, as the tenant's own credential row — this
 * copy is a duplicate of material the hub holds either way, never a new
 * class of secret.
 */
export const PENDING_SEED_TTL_MS = 24 * 60 * 60 * 1000;

const PROVIDER_IDS = supportedCredentialProviders().map((p) => p.id) as [
  SupportedCredentialProvider,
  ...SupportedCredentialProvider[],
];

const PendingSeedSecret = type({
  principalId: "string > 0",
  tenantDomain: "string > 0",
  apiKey: "string > 0",
});

export type PendingSeed = {
  readonly userId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly tenantDomain: string;
  readonly provider: SupportedCredentialProvider;
  readonly apiKey: string;
};

export type PendingSeedDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

/** Domain separation on top of the AEAD tag, mirroring `pkce.ts`'s
 * `connectStateAad`: a row sealed for one provider's connect flow
 * cannot decrypt under another's. */
function pendingSeedAad(provider: string): string {
  return JSON.stringify(["onboarding-pending-seed", provider]);
}

export interface PendingSeedStore {
  /** Upserts the single active row for (userId, tenantId) — a fresh
   * connect always replaces whatever pending seed came before it. */
  put(
    seed: PendingSeed,
    args?: { ttlMs?: number; now?: () => number },
  ): Promise<void>;
  /**
   * Reads and validates the row for exactly the signed-in user and
   * tenant this request already resolved — a row belonging to a
   * different user or tenant is simply a different key and is never
   * found. A row that fails to validate (expired, corrupt, sealed
   * under a since-rotated key) is deleted as dead weight before this
   * returns `undefined`, rather than left to linger out its TTL —
   * this is the read-time TTL cleanup described in this module's
   * header comment. A row that validates is left in place; the caller
   * decides when to `clear` it (on successful seed).
   */
  read(args: {
    userId: string;
    tenantId: string;
    now?: () => number;
  }): Promise<PendingSeed | undefined>;
  /**
   * Every unexpired row, for the background drain that has no request —
   * and therefore no (userId, tenantId) — to scope itself by. This is
   * what makes provisioning survive a hub restart: the rows a crashed
   * process was mid-way through are still here, and the next boot's
   * first tick picks them straight back up. Expired rows are deleted on
   * the way past, the same read-time sweep `read` performs, so a dead
   * key is never handed to a drain. `limit` bounds one tick's work.
   */
  listDue(args: {
    now?: () => number;
    limit?: number;
  }): Promise<PendingSeed[]>;
  /** Deletes the row for (userId, tenantId), if any. Called once the
   * pending seed has done its job (seeded successfully) or once the
   * bench already reads as fully seeded some other way. */
  clear(args: { userId: string; tenantId: string }): Promise<void>;
}

export const PENDING_SEED_SCAN_LIMIT = 50;

interface StoredRow {
  provider: string;
  payload: string;
  expiresAt: Date;
}

interface IdentifiedRow extends StoredRow {
  userId: string;
  tenantId: string;
}

interface RowAccess {
  get(userId: string, tenantId: string): Promise<StoredRow | undefined>;
  put(userId: string, tenantId: string, row: StoredRow): Promise<void>;
  delete(userId: string, tenantId: string): Promise<void>;
  list(limit: number): Promise<IdentifiedRow[]>;
}

function createPendingSeedStore(
  access: RowAccess,
  cipher: CredentialCipher,
): PendingSeedStore {
  /**
   * The single validity rule both readers apply: a row that is expired,
   * sealed for an unsupported provider, or undecryptable under the
   * current key is dead weight — deleted here and reported as absent,
   * rather than left to linger or handed onward as a usable seed.
   */
  async function decodeRow(
    row: IdentifiedRow,
    nowMs: number,
  ): Promise<PendingSeed | undefined> {
    const drop = async (): Promise<undefined> => {
      await access.delete(row.userId, row.tenantId);
      return undefined;
    };

    if (row.expiresAt.getTime() <= nowMs) return drop();
    if (!PROVIDER_IDS.includes(row.provider as SupportedCredentialProvider)) {
      return drop();
    }
    const provider = row.provider as SupportedCredentialProvider;

    try {
      const plaintext = await cipher.decrypt(
        row.payload,
        pendingSeedAad(provider),
      );
      const parsed = PendingSeedSecret(JSON.parse(plaintext));
      if (parsed instanceof type.errors) return drop();
      return {
        userId: row.userId,
        tenantId: row.tenantId,
        provider,
        principalId: parsed.principalId,
        tenantDomain: parsed.tenantDomain,
        apiKey: parsed.apiKey,
      };
    } catch {
      return drop();
    }
  }

  return {
    async put(seed, args = {}) {
      const now = args.now ?? Date.now;
      const ttlMs = args.ttlMs ?? PENDING_SEED_TTL_MS;
      const payload = await cipher.encrypt(
        JSON.stringify({
          principalId: seed.principalId,
          tenantDomain: seed.tenantDomain,
          apiKey: seed.apiKey,
        }),
        pendingSeedAad(seed.provider),
      );
      await access.put(seed.userId, seed.tenantId, {
        provider: seed.provider,
        payload,
        expiresAt: new Date(now() + ttlMs),
      });
    },

    async read(args) {
      const now = args.now ?? Date.now;
      const row = await access.get(args.userId, args.tenantId);
      if (row === undefined) return undefined;
      return decodeRow(
        { ...row, userId: args.userId, tenantId: args.tenantId },
        now(),
      );
    },

    async listDue(args) {
      const now = args.now ?? Date.now;
      const nowMs = now();
      const rows = await access.list(args.limit ?? PENDING_SEED_SCAN_LIMIT);
      const due: PendingSeed[] = [];
      for (const row of rows) {
        const seed = await decodeRow(row, nowMs);
        if (seed !== undefined) due.push(seed);
      }
      return due;
    },

    async clear(args) {
      await access.delete(args.userId, args.tenantId);
    },
  };
}

export function createDrizzlePendingSeedStore<
  TSchema extends Record<string, unknown>,
>(db: PendingSeedDb<TSchema>, cipher: CredentialCipher): PendingSeedStore {
  return createPendingSeedStore(
    {
      async get(userId, tenantId) {
        const [row] = await db
          .select()
          .from(pendingSeed)
          .where(
            and(
              eq(pendingSeed.userId, userId),
              eq(pendingSeed.tenantId, tenantId),
            ),
          );
        return row === undefined
          ? undefined
          : {
              provider: row.provider,
              payload: row.payload,
              expiresAt: row.expiresAt,
            };
      },
      async put(userId, tenantId, row) {
        await db
          .insert(pendingSeed)
          .values({
            userId,
            tenantId,
            provider: row.provider,
            payload: row.payload,
            expiresAt: row.expiresAt,
          })
          .onConflictDoUpdate({
            target: [pendingSeed.userId, pendingSeed.tenantId],
            set: {
              provider: row.provider,
              payload: row.payload,
              expiresAt: row.expiresAt,
            },
          });
      },
      async delete(userId, tenantId) {
        await db
          .delete(pendingSeed)
          .where(
            and(
              eq(pendingSeed.userId, userId),
              eq(pendingSeed.tenantId, tenantId),
            ),
          );
      },
      async list(limit) {
        const rows = await db.select().from(pendingSeed).limit(limit);
        return rows.map((row) => ({
          userId: row.userId,
          tenantId: row.tenantId,
          provider: row.provider,
          payload: row.payload,
          expiresAt: row.expiresAt,
        }));
      },
    },
    cipher,
  );
}

/** The fake this package's own tests drive routes through — no
 * Postgres required, same encrypt/validate/TTL semantics as the real
 * store. */
export function createInMemoryPendingSeedStore(
  cipher: CredentialCipher,
): PendingSeedStore {
  const rows = new Map<string, StoredRow>();
  const keyOf = (userId: string, tenantId: string) => `${userId}:${tenantId}`;
  return createPendingSeedStore(
    {
      async get(userId, tenantId) {
        return rows.get(keyOf(userId, tenantId));
      },
      async put(userId, tenantId, row) {
        rows.set(keyOf(userId, tenantId), row);
      },
      async delete(userId, tenantId) {
        rows.delete(keyOf(userId, tenantId));
      },
      async list(limit) {
        return [...rows.entries()].slice(0, limit).map(([key, row]) => {
          const [userId = "", tenantId = ""] = key.split(":");
          return { ...row, userId, tenantId };
        });
      },
    },
    cipher,
  );
}
