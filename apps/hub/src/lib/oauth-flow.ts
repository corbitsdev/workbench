import { createHash, randomBytes } from "node:crypto";
import { type } from "arktype";
import {
  resolveCredentialRequirement,
  resolveOAuthClient,
  resolveProviderByName,
  schema as intxSchema,
} from "@intx/db";
import { generateId } from "@intx/hub-common";
import { and, eq, isNotNull } from "drizzle-orm";
import type { OAuthProviderConfig } from "@workbench/shared";
import type { HubDb } from "../db";
import {
  decryptSecret,
  encryptSecret,
  signState,
  verifyState,
} from "./oauth-crypto";
import type { OAuthStatePayload } from "./oauth-crypto";
import { decryptToolCredentialSecret } from "./credential-crypto";

const { provider, oauthClient, credential } = intxSchema;

// Provider-agnostic OAuth flow engine (CL-3356 #2). Builds the authorize URL
// (PKCE + signed state), exchanges the code for a token at the provider's token
// endpoint, and inserts a PRINCIPAL-OWNED credential (`principalId = member`,
// `type: "oauth_token"`) with the access/refresh secrets envelope-encrypted AT
// WRITE. It builds ON the native Interchange credential shape — it never invents
// a parallel token store. The `fetch` transport is injected so the exchange can
// be driven deterministically in tests at the module boundary.

export type FetchLike = typeof fetch;

/** The resolved OAuth *app* client for a provider: the owner-set client_id +
 * client_secret plus the hub-derived redirect URI. Obtained via
 * `resolveOwnerOAuthClient` (a tenant credential the owner set on the
 * Capabilities page) — never an env var. */
export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

// Resolve the owner-set OAuth app client for a provider. The owner enters the
// app's Client secret (→ credential `secret`) and Client ID (→ the provider
// row's `metadata.baseURL` slot, the existing two-value owner-credential
// mechanism) on the Capabilities page under `appCredentialProviderName`. Returns
// null when the owner has not registered the app yet — the caller fails loudly
// (never stubs a client).
export async function resolveOwnerOAuthClient(
  db: HubDb,
  tenantId: string,
  providerConfig: OAuthProviderConfig,
  redirectUri: string,
): Promise<OAuthClientConfig | null> {
  const cred = await resolveCredentialRequirement(
    db,
    tenantId,
    {
      providerName: providerConfig.appCredentialProviderName,
      source: "tenant",
    },
    null,
    null,
  );
  if (!cred) return null;
  const providerRow = await resolveProviderByName(
    db,
    tenantId,
    providerConfig.appCredentialProviderName,
  );
  const meta = (providerRow?.metadata ?? {}) as Record<string, unknown>;
  const clientId = typeof meta["baseURL"] === "string" ? meta["baseURL"] : "";
  if (!clientId) return null;
  return {
    clientId,
    clientSecret: decryptToolCredentialSecret(cred.secret),
    redirectUri,
  };
}

// ─── PKCE ──────────────────────────────────────────────────────────

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ─── Pending-authorization store (server-side PKCE verifier) ───────
//
// The verifier must never leave the server, so it cannot ride the (client-held)
// state. Keyed by the state nonce with a short TTL; `take` is single-use.

export interface PendingAuthorization {
  verifier: string;
  expiresAt: number;
}

export interface PendingAuthorizationStore {
  put(nonce: string, entry: PendingAuthorization): void;
  take(nonce: string, now: number): PendingAuthorization | null;
}

export function createInMemoryPendingStore(): PendingAuthorizationStore {
  const map = new Map<string, PendingAuthorization>();
  return {
    put(nonce, entry) {
      map.set(nonce, entry);
    },
    take(nonce, now) {
      const entry = map.get(nonce);
      if (!entry) return null;
      map.delete(nonce);
      if (entry.expiresAt < now) return null;
      return entry;
    },
  };
}

const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1000;

// ─── Authorize URL ─────────────────────────────────────────────────

export interface BeginConnectArgs {
  providerConfig: OAuthProviderConfig;
  clientConfig: OAuthClientConfig;
  tenantId: string;
  memberPrincipalId: string;
  stateSecret: string;
  pendingStore: PendingAuthorizationStore;
  now?: () => number;
  pendingTtlMs?: number;
}

export function beginConnect(args: BeginConnectArgs): { redirectUrl: string } {
  const now = args.now?.() ?? Date.now();
  const nonce = randomBytes(18).toString("base64url");
  const state: OAuthStatePayload = {
    nonce,
    provider: args.providerConfig.providerName,
    tenantId: args.tenantId,
    memberPrincipalId: args.memberPrincipalId,
    issuedAt: now,
  };
  const signedState = signState(state, args.stateSecret);

  const url = new URL(args.providerConfig.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientConfig.clientId);
  url.searchParams.set("redirect_uri", args.clientConfig.redirectUri);
  url.searchParams.set("scope", args.providerConfig.scopes.join(" "));
  url.searchParams.set("state", signedState);

  if (args.providerConfig.usePkce) {
    const pkce = generatePkce();
    args.pendingStore.put(nonce, {
      verifier: pkce.verifier,
      expiresAt: now + (args.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS),
    });
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }

  return { redirectUrl: url.toString() };
}

// ─── Code-for-token exchange ───────────────────────────────────────

const OAuthTokenResponseSchema = type({
  access_token: "string > 0",
  "refresh_token?": "string",
  "expires_in?": "number",
  "scope?": "string",
  "token_type?": "string",
});
export type OAuthTokenResponse = typeof OAuthTokenResponseSchema.infer;

export interface ExchangeArgs {
  providerConfig: OAuthProviderConfig;
  clientConfig: OAuthClientConfig;
  code: string;
  verifier: string | null;
  fetchImpl: FetchLike;
}

export async function exchangeCodeForToken(
  args: ExchangeArgs,
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    client_id: args.clientConfig.clientId,
    client_secret: args.clientConfig.clientSecret,
    redirect_uri: args.clientConfig.redirectUri,
  });
  if (args.verifier) body.set("code_verifier", args.verifier);

  const res = await args.fetchImpl(args.providerConfig.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `OAuth token exchange failed for ${args.providerConfig.providerName}: ${res.status} ${detail}`,
    );
  }
  const json = (await res.json()) as unknown;
  const parsed = OAuthTokenResponseSchema(json);
  if (parsed instanceof type.errors) {
    throw new Error(
      `OAuth token response for ${args.providerConfig.providerName} did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed;
}

// ─── Provider / OAuth-client row resolution ────────────────────────

async function resolveOrCreateProvider(
  db: HubDb,
  tenantId: string,
  cfg: OAuthProviderConfig,
): Promise<string> {
  const existing = await resolveProviderByName(db, tenantId, cfg.providerName);
  if (existing) return existing.id;
  // Conflict-safe create: a concurrent callback may insert the same
  // (tenantId, name) first. onConflictDoNothing + re-resolve lets the loser
  // adopt the winner's row instead of throwing the unique violation.
  const id = generateId("provider");
  const [row] = await db
    .insert(provider)
    .values({
      id,
      tenantId,
      name: cfg.providerName,
      plugin: cfg.providerName,
      authorizationUrl: cfg.authorizationUrl,
      tokenUrl: cfg.tokenUrl,
      scopes: [...cfg.scopes],
    })
    .onConflictDoNothing({ target: [provider.tenantId, provider.name] })
    .returning({ id: provider.id });
  if (row) return row.id;
  const raced = await resolveProviderByName(db, tenantId, cfg.providerName);
  if (!raced) throw new Error("resolveOrCreateProvider: provider not found");
  return raced.id;
}

async function resolveOrCreateOAuthClient(
  db: HubDb,
  tenantId: string,
  providerId: string,
  cfg: OAuthProviderConfig,
  clientConfig: OAuthClientConfig,
): Promise<string> {
  const existing = await resolveOAuthClient(db, tenantId, providerId);
  if (existing) return existing.id;
  const id = generateId("oauthClient");
  const [row] = await db
    .insert(oauthClient)
    .values({
      id,
      tenantId,
      providerId,
      name: cfg.label,
      clientId: clientConfig.clientId,
      clientSecret: clientConfig.clientSecret,
      redirectUris: [clientConfig.redirectUri],
      defaultScopes: [...cfg.scopes],
    })
    .onConflictDoNothing({
      target: [oauthClient.tenantId, oauthClient.providerId],
    })
    .returning({ id: oauthClient.id });
  if (row) return row.id;
  const raced = await resolveOAuthClient(db, tenantId, providerId);
  if (!raced) throw new Error("resolveOrCreateOAuthClient: client not found");
  return raced.id;
}

// ─── Principal-owned credential insert (encrypt-at-write) ──────────

export interface InsertOAuthCredentialArgs {
  db: HubDb;
  tenantId: string;
  memberPrincipalId: string;
  providerConfig: OAuthProviderConfig;
  clientConfig: OAuthClientConfig;
  token: OAuthTokenResponse;
  now?: () => number;
}

/** The credential name is deterministic per (provider, member) so a re-connect
 * updates the same row rather than colliding on the tenant-unique name. */
export function oauthCredentialName(
  providerName: string,
  memberPrincipalId: string,
): string {
  return `oauth:${providerName}:${memberPrincipalId}`;
}

export async function insertOAuthCredential(
  args: InsertOAuthCredentialArgs,
): Promise<{ credentialId: string }> {
  const now = args.now?.() ?? Date.now();
  const providerId = await resolveOrCreateProvider(
    args.db,
    args.tenantId,
    args.providerConfig,
  );
  const oauthClientId = await resolveOrCreateOAuthClient(
    args.db,
    args.tenantId,
    providerId,
    args.providerConfig,
    args.clientConfig,
  );

  const scopes = args.token.scope
    ? args.token.scope.split(/\s+/).filter(Boolean)
    : [...args.providerConfig.scopes];
  const expiresAt =
    args.token.expires_in !== undefined
      ? new Date(now + args.token.expires_in * 1000)
      : null;
  const secret = encryptSecret(args.token.access_token);
  const refreshSecret = args.token.refresh_token
    ? encryptSecret(args.token.refresh_token)
    : null;
  const name = oauthCredentialName(
    args.providerConfig.providerName,
    args.memberPrincipalId,
  );

  // Atomic upsert on the tenant-unique credential name: two concurrent callback
  // completions for the same (provider, member) collapse to one row — the
  // second updates instead of throwing the unique(tenantId, name) violation the
  // prior findFirst→insert path raced on.
  const id = generateId("credential");
  const [row] = await args.db
    .insert(credential)
    .values({
      id,
      tenantId: args.tenantId,
      principalId: args.memberPrincipalId,
      providerId,
      oauthClientId,
      name,
      type: "oauth_token",
      secret,
      refreshSecret,
      scopes,
      expiresAt,
      status: "active",
    })
    .onConflictDoUpdate({
      target: [credential.tenantId, credential.name],
      set: {
        principalId: args.memberPrincipalId,
        providerId,
        oauthClientId,
        type: "oauth_token",
        secret,
        refreshSecret,
        scopes,
        expiresAt,
        status: "active",
        updatedAt: new Date(now),
      },
    })
    .returning({ id: credential.id });
  if (!row) throw new Error("insertOAuthCredential: upsert returned no row");
  return { credentialId: row.id };
}

// ─── Callback orchestration ────────────────────────────────────────

export interface CompleteConnectArgs {
  db: HubDb;
  providerConfig: OAuthProviderConfig;
  clientConfig: OAuthClientConfig;
  code: string;
  state: string;
  stateSecret: string;
  pendingStore: PendingAuthorizationStore;
  fetchImpl: FetchLike;
  now?: () => number;
  /** Max age (ms) a signed state is accepted for. Replay protection that does
   * NOT depend on the provider using PKCE — a non-PKCE provider still gets a
   * bounded acceptance window. Defaults to the pending-store TTL. */
  stateMaxAgeMs?: number;
}

export interface CompleteConnectResult {
  credentialId: string;
  tenantId: string;
  memberPrincipalId: string;
}

export class OAuthStateError extends Error {}

export async function completeConnect(
  args: CompleteConnectArgs,
): Promise<CompleteConnectResult> {
  const now = args.now?.() ?? Date.now();
  const payload = verifyState(args.state, args.stateSecret);
  if (!payload) {
    throw new OAuthStateError("Invalid or tampered OAuth state");
  }
  if (payload.provider !== args.providerConfig.providerName) {
    throw new OAuthStateError("OAuth state provider mismatch");
  }
  const maxAgeMs = args.stateMaxAgeMs ?? DEFAULT_PENDING_TTL_MS;
  if (now - payload.issuedAt > maxAgeMs) {
    throw new OAuthStateError("OAuth state expired");
  }

  let verifier: string | null = null;
  if (args.providerConfig.usePkce) {
    const pending = args.pendingStore.take(payload.nonce, now);
    if (!pending) {
      throw new OAuthStateError("OAuth authorization expired or already used");
    }
    verifier = pending.verifier;
  }

  const token = await exchangeCodeForToken({
    providerConfig: args.providerConfig,
    clientConfig: args.clientConfig,
    code: args.code,
    verifier,
    fetchImpl: args.fetchImpl,
  });

  const { credentialId } = await insertOAuthCredential({
    db: args.db,
    tenantId: payload.tenantId,
    memberPrincipalId: payload.memberPrincipalId,
    providerConfig: args.providerConfig,
    clientConfig: args.clientConfig,
    token,
    now: () => now,
  });

  return {
    credentialId,
    tenantId: payload.tenantId,
    memberPrincipalId: payload.memberPrincipalId,
  };
}

// Whether a member holds an active principal-owned OAuth credential for a
// provider. Read side of the Connections surface; never returns the secret.
export async function findMemberConnection(
  db: HubDb,
  tenantId: string,
  memberPrincipalId: string,
  providerName: string,
): Promise<{ scopes: string[]; needsReconnect: boolean } | null> {
  const providerRow = await resolveProviderByName(db, tenantId, providerName);
  if (!providerRow) return null;
  const row = await db.query.credential.findFirst({
    where: and(
      eq(credential.tenantId, tenantId),
      eq(credential.providerId, providerRow.id),
      eq(credential.principalId, memberPrincipalId),
      eq(credential.type, "oauth_token"),
      isNotNull(credential.principalId),
    ),
    columns: { scopes: true, status: true },
  });
  if (!row) return null;
  return {
    scopes: row.scopes ?? [],
    needsReconnect: row.status !== "active",
  };
}

/** A member's usable, DECRYPTED OAuth token for a provider. */
export interface ResolvedOAuthToken {
  credentialId: string;
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
  expiresAt: Date | null;
}

// The read side of the encrypt-at-write contract (CL-3356 pillar B). Resolves
// the member's principal-owned `oauth_token` credential through the native
// `resolveCredentialRequirement` (source: "invoker", so it filters by the
// member principal and skips non-active rows) and DECRYPTS the stored envelope
// into a usable token.
//
// EVERY OAuth-token consumer MUST go through this — never read the credential's
// `secret` via raw `resolveCredentialRequirement`, which returns the opaque
// `v1:...` envelope. Returns null when the member has no active connection.
//
// NOTE: the actual inbox acting-as CONSUMER (the resolver wrapper that prefers
// this user token over the tenant key, and threads it into triage tool
// execution) is a separate CL-3356 follow-up; this helper is the correct read
// primitive it will build on.
export async function resolveOAuthToken(
  db: HubDb,
  tenantId: string,
  memberPrincipalId: string,
  providerName: string,
): Promise<ResolvedOAuthToken | null> {
  if (!memberPrincipalId) return null;
  const cred = await resolveCredentialRequirement(
    db,
    tenantId,
    { providerName, source: "invoker" },
    null,
    memberPrincipalId,
  );
  if (!cred || cred.type !== "oauth_token") return null;
  return {
    credentialId: cred.id,
    accessToken: decryptSecret(cred.secret),
    refreshToken: cred.refreshSecret ? decryptSecret(cred.refreshSecret) : null,
    scopes: cred.scopes ?? [],
    expiresAt: cred.expiresAt ?? null,
  };
}
