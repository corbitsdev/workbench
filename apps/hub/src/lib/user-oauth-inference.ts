import { and, eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { getLogger } from "@intx/log";
import type { InferenceSource } from "@intx/types/runtime";
import type { GrantStore } from "@intx/types/authz";
import {
  findOAuthProviderConfig,
  inferenceOAuthProviders,
  isOAuthProviderAvailable,
  type OAuthProviderConfig,
} from "@workbench/shared";
import { enabledUserOAuthInferenceProviders } from "../config";
import type { HubDb } from "../db";
import { isCapabilityAllowedForPrincipal } from "./capability-grants";
import { decryptSecret, encryptSecret } from "./oauth-crypto";
import {
  oauthCredentialName,
  refreshOAuthToken,
  resolveOAuthClientForProvider,
  type FetchLike,
} from "./oauth-flow";
import { oauthCallbackRedirectUri } from "./oauth-redirect";

const { credential } = intxSchema;

const log = getLogger(["api", "user-oauth-inference"]);

/**
 * Build InferenceSource rows from the invoker's connected user-self-OAuth
 * inference providers (xAI/Grok, ChatGPT/Codex). Sources are keyed by model
 * name so launch can prefer them when a required model is covered by a
 * connection.
 *
 * Access tokens are refreshed when within `inference.refreshSkewMs` of expiry
 * (or already expired) when a refresh_token is present.
 *
 * Capability grants are re-checked at launch (same gate as connect) so an
 * owner deny after connect stops injection even if the credential row remains.
 */
export async function resolveUserOAuthInferenceSources(opts: {
  db: HubDb;
  tenantId: string;
  memberPrincipalId: string;
  /** Restrict to these model names; omit to emit all models for connected providers. */
  modelNames?: readonly string[];
  /** Hub public base used to rebuild the redirect_uri for refresh (must match authorize). */
  redirectUriBase: string;
  /** When set, skip providers the principal is not capability-allowed for. */
  grantStore?: GrantStore;
  fetchImpl?: FetchLike;
  now?: () => number;
}): Promise<InferenceSource[]> {
  const now = opts.now?.() ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const modelFilter =
    opts.modelNames !== undefined ? new Set(opts.modelNames) : null;
  const sources: InferenceSource[] = [];

  const enabledProviders = enabledUserOAuthInferenceProviders();

  for (const providerConfig of inferenceOAuthProviders()) {
    const inference = providerConfig.inference;
    if (!inference) continue;

    // Deployment gate. Disabling a provider must stop injection immediately,
    // not merely hide the Connect button: a credential from a previously
    // enabled environment (or a restored database) would otherwise keep
    // billing a member's personal subscription after the operator turned the
    // provider off.
    if (!isOAuthProviderAvailable(providerConfig, enabledProviders)) continue;

    if (opts.grantStore) {
      const allowed = await isCapabilityAllowedForPrincipal(
        opts.grantStore,
        opts.tenantId,
        opts.memberPrincipalId,
        providerConfig.providerName,
      );
      if (!allowed) continue;
    }

    const name = oauthCredentialName(
      providerConfig.providerName,
      opts.memberPrincipalId,
    );
    // Read the credential row directly rather than through
    // `resolveCredentialRequirement`. That helper resolves a *tenant-hierarchy*
    // credential by (providerName, source) — the model_provider shape used for
    // shared API keys. What is needed here is the opposite: one specific
    // principal-scoped `oauth_token` row, identified by the deterministic
    // per-(provider, member) credential name, whose refresh_token and expiry
    // must be read and rewritten. The hierarchy walk would happily return a
    // different member's or the tenant's credential, which is exactly the
    // isolation this lookup must not lose.
    const row = await opts.db.query.credential.findFirst({
      where: and(
        eq(credential.tenantId, opts.tenantId),
        eq(credential.name, name),
        eq(credential.status, "active"),
      ),
    });
    if (!row || row.type !== "oauth_token") continue;

    let accessToken = decryptSecret(row.secret);
    const expiresAt = row.expiresAt?.getTime() ?? null;
    const skew = inference.refreshSkewMs;
    const needsRefresh =
      providerConfig.hasRefresh &&
      row.refreshSecret != null &&
      (expiresAt === null || expiresAt - now <= skew);

    if (needsRefresh && row.refreshSecret) {
      try {
        const redirectUri = oauthCallbackRedirectUri(
          opts.redirectUriBase,
          providerConfig.providerName,
        );
        const clientConfig = await resolveOAuthClientForProvider(
          opts.db,
          opts.tenantId,
          providerConfig,
          redirectUri,
        );
        if (clientConfig) {
          const refreshed = await refreshOAuthToken({
            providerConfig,
            clientConfig,
            refreshToken: decryptSecret(row.refreshSecret),
            fetchImpl,
          });
          accessToken = refreshed.access_token;
          const newExpires =
            refreshed.expires_in !== undefined
              ? new Date(now + refreshed.expires_in * 1000)
              : null;
          const newRefresh = refreshed.refresh_token
            ? encryptSecret(refreshed.refresh_token)
            : row.refreshSecret;
          await opts.db
            .update(credential)
            .set({
              secret: encryptSecret(refreshed.access_token),
              refreshSecret: newRefresh,
              expiresAt: newExpires,
              updatedAt: new Date(now),
            })
            .where(eq(credential.id, row.id));
        }
      } catch (err) {
        // A refresh failure is usually the member revoking Workbench at the
        // provider, or an expired refresh token — both end as an opaque 401 at
        // first inference. Log it so that 401 is traceable to a cause, then
        // fall through with the stale access token, which the provider may
        // still accept inside its grace window. The message is already bounded
        // and scrubbed by `summarizeTokenErrorBody` in `refreshOAuthToken`.
        log.warn("User OAuth inference token refresh failed", {
          error: err,
          providerName: providerConfig.providerName,
          tenantId: opts.tenantId,
          memberPrincipalId: opts.memberPrincipalId,
          credentialId: row.id,
          expiredBeforeRefresh: expiresAt !== null && expiresAt <= now,
        });
      }
    }

    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const providerOptions: Record<string, unknown> = {};
    if (
      providerConfig.providerName === "chatgpt-codex" &&
      typeof meta["chatgptAccountId"] === "string"
    ) {
      providerOptions["codexAccountId"] = meta["chatgptAccountId"];
    }

    for (const model of inference.models) {
      if (modelFilter && !modelFilter.has(model)) continue;
      const source: InferenceSource = {
        id: `user-oauth:${providerConfig.providerName}:${model}`,
        provider: inference.plugin,
        baseURL: inference.baseURL,
        apiKey: accessToken,
        model,
      };
      if (Object.keys(providerOptions).length > 0) {
        source.defaults = { providerOptions: { ...providerOptions } };
      }
      sources.push(source);
    }
  }

  return sources;
}

/**
 * Merge catalog-resolved sources with user-OAuth sources. For each model that
 * appears in both, user-OAuth sources are prepended so a connected personal
 * subscription is preferred over tenant API keys when the model matches.
 * OAuth-only models (not in the catalog resolution) are appended.
 */
export function mergeUserOAuthSources(
  catalogSources: InferenceSource[],
  oauthSources: InferenceSource[],
): InferenceSource[] {
  if (oauthSources.length === 0) return catalogSources;
  if (catalogSources.length === 0) return oauthSources;

  const catalogByModel = new Map<string, InferenceSource[]>();
  for (const s of catalogSources) {
    const list = catalogByModel.get(s.model) ?? [];
    list.push(s);
    catalogByModel.set(s.model, list);
  }

  const oauthByModel = new Map<string, InferenceSource[]>();
  for (const s of oauthSources) {
    const list = oauthByModel.get(s.model) ?? [];
    list.push(s);
    oauthByModel.set(s.model, list);
  }

  const models = new Set([...catalogByModel.keys(), ...oauthByModel.keys()]);
  // Preserve catalog model order, then any oauth-only models.
  const orderedModels: string[] = [];
  for (const s of catalogSources) {
    if (!orderedModels.includes(s.model)) orderedModels.push(s.model);
  }
  for (const m of models) {
    if (!orderedModels.includes(m)) orderedModels.push(m);
  }

  const out: InferenceSource[] = [];
  for (const model of orderedModels) {
    out.push(...(oauthByModel.get(model) ?? []));
    out.push(...(catalogByModel.get(model) ?? []));
  }
  return out;
}

/** Whether a catalog config is an inference-capable user OAuth provider. */
export function isUserOAuthInferenceProvider(providerName: string): boolean {
  const cfg = findOAuthProviderConfig(providerName);
  return cfg?.inference !== undefined;
}

export type { OAuthProviderConfig };
