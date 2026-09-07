// Serving-time credential refresh for inference `oauth_token` credentials
// (CL-7505).
//
// The live serving-time trigger is the chat platform's `sendMail` choke
// point: ahead of every send, `createTenantServingRefresh` refreshes each
// due `oauth_token` credential in the tenant — via the connections token
// session (`@corbits/connections`'s `createCredentialTokenSession`, over
// the vendored `@corbits/oauth-core`), coalesced and skew-aware — and the
// refreshed material reaches running deployments through the existing
// `credentials-updated` push (`pushSourceUpdates` → `sendCredentialsUpdate`).
// The existing MCP expiry sweep keeps running as the background backstop
// and reconnect-nudge path.
//
// The vendored material-resolution seam (`@intx/db`'s `buildSource`,
// threaded through `resolveModelSources` / `resolveInstanceModelSources` /
// `resolveDefinitionSources` / the hub-sessions push path as the recorded
// CL-7505 delta) also accepts this hook, but no production caller supplies
// it yet — it is reserved for launch-time resolution on the CL-7505
// umbrella; do not cite it as a live trigger.
//
// On a failed refresh the credential is marked `status: "error"` — the
// Connections card reads any non-`active` status as needs-attention — and
// the hook reports `ok: false`, which makes the serving seam SKIP the
// offering: an unauthenticated dial is never served. The expiry sweep's
// mail nudge remains the human backstop for the same dead credential.
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { type } from "arktype";
import { credential, provider } from "@intx/db/schema";
import type { DB } from "@intx/db";
import type { ServingRefresh } from "@intx/db";
import { getLogger } from "@intx/log";
import {
  createCredentialTokenSession,
  type CredentialTokenRow,
  type RefreshedTokens,
} from "@corbits/connections/token-session";
import { pushSourceUpdates, type SidecarRouter } from "@intx/hub-sessions";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { mcpSlugOf, refreshMcpOAuthTokens } from "@corbits/connections";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const log = getLogger(["hub", "credential-material-refresh"]);

// Re-check this far ahead of the stored `expiresAt`: inside the lead the
// token is treated as expiring and refreshed, so a dial that starts now
// still lands on a live token after its round trip. Matches the token
// session's own default skew lead.
const SKEW_LEAD_MS = 60 * 1000;

const CredentialMetadata = type({
  url: "string",
  "name?": "string",
  "clientInformation?": "unknown",
});

/** The row shape the serving seam hands the hook (a `credential` row
 * subset; `refreshSecret` still ciphertext). */
export type ServingCredentialRow = {
  readonly id: string;
  readonly tenantId: string;
  readonly type: string;
  readonly status: string;
  readonly refreshSecret: string | null;
  readonly expiresAt: Date | null;
};

/** Everything the refresh needs from persistence and delivery, behind a
 * store seam so the orchestration is testable without a live Postgres. */
export type ServingRefreshStore = {
  /** The full current row for a credential id (still-encrypted secrets),
   * or null when it is gone. */
  loadRow(credentialId: string): Promise<
    | (ServingCredentialRow & {
        readonly secret: string;
        readonly providerName: string;
        readonly apiBaseUrl: string | null;
        readonly metadata: unknown;
      })
    | null
  >;
  /** Persists a successful refresh (encrypting the new pair) — only an
   * `active` row is updated; false means it was claimed meanwhile. */
  applyRefreshedTokens(
    credentialId: string,
    tokens: RefreshedTokens,
  ): Promise<boolean>;
  /** Marks the credential re-auth-required: visible to the settings
   * Connections card as needs-attention. */
  markReauthRequired(credentialId: string, reason: string): Promise<void>;
  /** Re-resolves and pushes `credentials-updated` frames for the tenant's
   * running instances, so sidecars pick the new material up live. */
  pushUpdates(tenantId: string): Promise<void>;
  /** Decrypts a stored secret column for the grant. */
  decrypt(
    credentialId: string,
    column: "secret" | "refreshSecret",
    value: string,
  ): Promise<string>;
  /** Every `active` `oauth_token` credential in the tenant whose stored
   * `expiresAt` is at or before `cutoff` — the tenant-wide serving-time
   * sweep `refreshTenantServingCredentials` runs ahead of a dial. */
  loadDueRows(tenantId: string, cutoff: Date): Promise<ServingCredentialRow[]>;
};

export type ServingRefreshGrantArgs = {
  readonly credentialId: string;
  readonly tenantId: string;
  readonly providerName: string;
  readonly serverUrl: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly clientInformation?: OAuthClientInformationMixed;
};

export type ServingRefreshDeps = {
  store: ServingRefreshStore;
  hubUrl: string;
  /** The provider-pluggable refresh grant. Defaults to the generalized
   * MCP `auth()` refresh (any provider whose metadata carries the server
   * URL / registered client); a different credential class supplies its
   * own grant here without touching this module. */
  grant?: (args: ServingRefreshGrantArgs) => Promise<{
    accessToken: string;
    refreshToken?: string;
    /** Lifetime in seconds, per RFC 6749 §5.1 `expires_in`. */
    expiresIn?: number;
  }>;
  now?: () => number;
};

export function createServingRefresh(deps: ServingRefreshDeps): ServingRefresh {
  const now = deps.now ?? Date.now;
  const grant =
    deps.grant ??
    (async (args: ServingRefreshGrantArgs) => {
      const tokens: OAuthTokens = {
        access_token: args.accessToken,
        token_type: "bearer",
        refresh_token: args.refreshToken,
      };
      const result = await refreshMcpOAuthTokens({
        serverUrl: args.serverUrl,
        tokens,
        ...(args.clientInformation === undefined
          ? {}
          : { clientInformation: args.clientInformation }),
        callbackUrl: new URL(
          `/api/tenants/${args.tenantId}/mcp-servers/oauth/${mcpSlugOf(args.providerName)}/callback`,
          deps.hubUrl,
        ).toString(),
        clientName: "Corbits Workbench",
      });
      if (!result.ok) throw new Error(result.message);
      return {
        accessToken: result.tokens.access_token,
        ...(result.tokens.refresh_token === undefined
          ? {}
          : { refreshToken: result.tokens.refresh_token }),
        ...(result.tokens.expires_in === undefined
          ? {}
          : { expiresIn: result.tokens.expires_in }),
      };
    });

  const sessions = new Map<string, ReturnType<typeof buildSession>>();
  let lastApplyWon = true;

  function buildSession() {
    return createCredentialTokenSession({
      now,
      skewLeadMs: SKEW_LEAD_MS,
      loadProfile: async (credentialId) => {
        const row = await deps.store.loadRow(credentialId);
        if (row === null) return null;
        return {
          id: row.id,
          type: row.type,
          secret: await deps.store.decrypt(row.id, "secret", row.secret),
          refreshSecret:
            row.refreshSecret === null
              ? null
              : await deps.store.decrypt(
                  row.id,
                  "refreshSecret",
                  row.refreshSecret,
                ),
          expiresAt: row.expiresAt,
        } satisfies CredentialTokenRow;
      },
      updateTokens: async (credentialId, tokens) => {
        // False = another writer claimed the row (claimed-elsewhere): a
        // lost race, not an error — skip the follow-up push and let the
        // next resolution re-read whatever was persisted.
        const applied = await deps.store.applyRefreshedTokens(
          credentialId,
          tokens,
        );
        lastApplyWon = applied;
      },
      refresh: async (row) => {
        const full = await deps.store.loadRow(row.id);
        if (full === null || row.refreshSecret === null) {
          throw new Error(`credential ${row.id} lost its refresh secret`);
        }
        const parsed = CredentialMetadata(full.metadata ?? {});
        const serverUrl =
          full.apiBaseUrl ??
          (parsed instanceof type.errors ? undefined : parsed.url);
        if (serverUrl === undefined) {
          throw new Error(
            `credential ${row.id} has neither a provider API base URL nor a metadata URL to refresh against`,
          );
        }
        const refreshed = await grant({
          credentialId: row.id,
          tenantId: full.tenantId,
          providerName: full.providerName,
          serverUrl,
          accessToken: row.secret,
          refreshToken: row.refreshSecret,
          ...(parsed instanceof type.errors ||
          parsed.clientInformation === undefined
            ? {}
            : {
                clientInformation:
                  parsed.clientInformation as OAuthClientInformationMixed,
              }),
        });
        return {
          secret: refreshed.accessToken,
          ...(refreshed.refreshToken === undefined
            ? {}
            : { refreshSecret: refreshed.refreshToken }),
          // No `expires_in` stated: persist a NULL expiry — non-due, per
          // the vendored oauth-core stance. Never a short artificial
          // timer that would re-refresh on every dial.
          expiresAt:
            refreshed.expiresIn === undefined
              ? null
              : new Date(now() + refreshed.expiresIn * 1000),
        };
      },
    });
  }

  return async (serving: ServingCredentialRow) => {
    // Only `oauth_token` rows refresh; an `api_key` (or any other class)
    // takes its exact prior path, untouched.
    if (serving.type !== "oauth_token") return { ok: true };
    // An already-marked credential is past saving: skip it without another
    // doomed grant, until a human reconnects.
    if (serving.status !== "active") {
      return {
        ok: false,
        message: `credential ${serving.id} is ${serving.status} — re-authorization required`,
      };
    }
    // No stored expiry (or no refresh grant stored): the column says the
    // token is not expiring, so serve as before.
    if (serving.expiresAt === null) return { ok: true };
    if (serving.expiresAt.getTime() - SKEW_LEAD_MS > now()) return { ok: true };

    lastApplyWon = true;
    let session = sessions.get(serving.id);
    if (session === undefined) {
      session = buildSession();
      sessions.set(serving.id, session);
    }
    const result = await session.getValidToken(serving.id);
    if (result.ok) {
      if (result.refreshed && lastApplyWon) {
        // Deliver the fresh material to every running instance in the
        // tenant via the existing credentials-updated push. A lost
        // apply race (another writer claimed the row) already persisted
        // someone else's tokens — skip the redundant push.
        await deps.store.pushUpdates(serving.tenantId);
      }
      return { ok: true };
    }
    if (result.reauthRequired) {
      await deps.store.markReauthRequired(serving.id, result.message);
      await deps.store.pushUpdates(serving.tenantId);
      log.warn`credential ${serving.id} needs re-authorization: ${result.message}`;
    }
    return { ok: false, message: result.message };
  };
}

export function createDrizzleServingRefreshStore(
  db: DB["db"],
  credentialCipher: CredentialCipher,
  sidecarRouter: SidecarRouter,
): ServingRefreshStore {
  return {
    async loadRow(credentialId) {
      const rows = await db
        .select({
          id: credential.id,
          tenantId: credential.tenantId,
          type: credential.type,
          status: credential.status,
          secret: credential.secret,
          refreshSecret: credential.refreshSecret,
          expiresAt: credential.expiresAt,
          providerName: provider.name,
          apiBaseUrl: provider.apiBaseUrl,
          metadata: credential.metadata,
        })
        .from(credential)
        .innerJoin(provider, eq(provider.id, credential.providerId))
        .where(eq(credential.id, credentialId))
        .limit(1);
      return rows[0] ?? null;
    },
    async applyRefreshedTokens(credentialId, tokens) {
      const now = new Date();
      const encryptedSecret = await credentialCipher.encrypt(
        tokens.secret,
        credentialAad(credentialId, "secret"),
      );
      const encryptedRefreshSecret =
        tokens.refreshSecret === undefined
          ? undefined
          : await credentialCipher.encrypt(
              tokens.refreshSecret,
              credentialAad(credentialId, "refreshSecret"),
            );
      // Only an `active` row is updated: a row a racing writer already
      // claimed as expired/re-auth-required must not be resurrected with
      // fresh tokens — the false return is the caller's lost-race signal.
      const updated = await db
        .update(credential)
        .set({
          secret: encryptedSecret,
          ...(encryptedRefreshSecret !== undefined
            ? { refreshSecret: encryptedRefreshSecret }
            : {}),
          expiresAt: tokens.expiresAt,
          updatedAt: now,
        })
        .where(
          and(eq(credential.id, credentialId), eq(credential.status, "active")),
        )
        .returning({ id: credential.id });
      return updated.length > 0;
    },
    async markReauthRequired(credentialId, _reason) {
      await db
        .update(credential)
        .set({
          status: "error",
          updatedAt: new Date(),
        })
        .where(eq(credential.id, credentialId));
    },
    pushUpdates: (tenantId) =>
      pushSourceUpdates(db, sidecarRouter, tenantId, credentialCipher),
    decrypt: (credentialId, column, value) =>
      credentialCipher.decrypt(value, credentialAad(credentialId, column)),
    async loadDueRows(tenantId, cutoff) {
      return db
        .select({
          id: credential.id,
          tenantId: credential.tenantId,
          type: credential.type,
          status: credential.status,
          refreshSecret: credential.refreshSecret,
          expiresAt: credential.expiresAt,
        })
        .from(credential)
        .where(
          and(
            eq(credential.tenantId, tenantId),
            eq(credential.type, "oauth_token"),
            eq(credential.status, "active"),
            isNotNull(credential.expiresAt),
            lte(credential.expiresAt, cutoff),
          ),
        );
    },
  };
}

/**
 * The tenant-wide serving-time trigger: refresh every due `oauth_token`
 * credential in the tenant, then (per credential, inside the hook) push the
 * updated frames. Runs best-effort ahead of a serving dial — the chat
 * platform calls it at `sendMail` — never rejecting, so a refresh failure
 * only marks the credential and lets the dial fail over to a live source.
 */
export function createTenantServingRefresh(
  deps: ServingRefreshDeps & { skewLeadMs?: number },
): (tenantId: string) => Promise<void> {
  const refresh = createServingRefresh(deps);
  const skewLeadMs = deps.skewLeadMs ?? 60 * 1000;
  const now = deps.now ?? Date.now;
  return async (tenantId: string) => {
    const due = await deps.store.loadDueRows(
      tenantId,
      new Date(now() + skewLeadMs),
    );
    await Promise.all(due.map((row) => refresh(row)));
  };
}
