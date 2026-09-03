// CL-6101: schedules the env-key auto-plant at hub boot. The actual
// planting is `@workbench/onboarding`'s `plantEnvProviderCredentials`
// (reused, not reimplemented); this module's only job is finding the
// tenant it should run against and running it without ever blocking or
// failing hub boot.
//
// The target tenant is resolved the same way `workbench setup` /
// `workbench seed` resolve it: sign in as the administrator
// (HUB_ADMIN_EMAIL/PASSWORD, defaulted the same way those commands
// default them) and look up the bench named ORG_SLUG among that
// account's own memberships. On a virgin database neither the admin
// account nor that bench exist yet — `workbench setup` (or `bun run
// dev`'s own account seeding) creates them, often as a separate
// process, well after this hub has already started serving. Rather
// than fail hub boot over a bench that legitimately doesn't exist yet,
// an unresolved target is retried with backoff until it resolves; the
// retry itself is logged only once per distinct failure reason, never
// on every tick.
//
// Sign-in only, never sign-up: unlike `workbench setup`/`workbench
// seed`, this runs unattended at every hub boot, including against a
// virgin, open-signup database. Falling through to sign-up the way
// those interactive commands do would let a boot-time retry tick mint
// the default admin account (and its default password) on its own —
// so this module authenticates with `@corbits/hub-api-client`'s
// sign-in-only `signIn`, and an unresolved admin account is treated
// exactly like an unresolved bench: retried quietly, never a reason to
// self-provision the account.
//
// Runs entirely in-process against the fully composed, guarded app's
// own `fetch` — no network hop, no dependency on `Bun.serve` already
// listening on a real port. This is the same "call the hub's own HTTP
// API as a typed client" idiom `selfApi` (this file's caller, for
// `@workbench/access-policy`'s routes) already uses, just wired to an
// in-process request entry point instead of a real origin so the very
// first attempt can run before the process is accepting connections.

import { getLogger } from "@intx/log";
import { paginatedSchema, PrincipalSummary } from "@intx/types";
import {
  signIn,
  createHubAPI,
  parseAs,
  type ApiCall,
  type Session,
} from "@corbits/hub-api-client";
import {
  plantEnvProviderCredentials,
  type PlantEnvProviderCredentialsOutcome,
} from "@workbench/onboarding";
import type { HubConfig } from "./config";

const DEFAULT_RETRY_INTERVAL_MS = 10_000;
const DEFAULT_MAX_RETRY_INTERVAL_MS = 5 * 60_000;
const DEFAULT_GIVE_UP_AFTER_MS = 24 * 60 * 60_000;

const log = getLogger(["hub", "env-credential-plant"]);

export type EnvCredentialPlantDeps = {
  baseUrl: string;
  envProviderKeys: HubConfig["envProviderKeys"];
  envProviderBaseUrls: HubConfig["envProviderBaseUrls"];
  envProviderPreferredModels?: HubConfig["envProviderPreferredModels"];
  admin: HubConfig["envCredentialPlantAdmin"];
  /** The fully composed, guarded app's own request entry point. */
  fetch: (request: Request) => Promise<Response>;
  retryIntervalMs?: number;
  /** Backoff cap; the retry interval doubles each unresolved tick up to
   * this ceiling. Defaults to 5 minutes. */
  maxRetryIntervalMs?: number;
  /** Total time to keep retrying an unresolved target before giving up
   * for good. Defaults to 24 hours. */
  giveUpAfterMs?: number;
  /** Test seam: a fake replaces the real `plantEnvProviderCredentials`
   * the same way `seedCatalogFn` replaces the real `seedCatalog`
   * elsewhere in this codebase, so this module's own retry-until-
   * resolved scheduling is testable without a live probe or a real
   * catalog plant. */
  plant?: typeof plantEnvProviderCredentials;
};

function localFetchImpl(
  entry: (request: Request) => Promise<Response>,
): typeof fetch {
  return ((input, init) =>
    entry(new Request(input as string, init as RequestInit))) as typeof fetch;
}

type TenantLookup =
  | { outcome: "resolved"; tenantId: string }
  | { outcome: "unauthorized" }
  | { outcome: "not-found" };

async function resolveOperatorTenantId(
  api: ApiCall,
  cookies: string[],
  orgSlug: string,
): Promise<TenantLookup> {
  const response = await api("GET", "/api/me/principals", undefined, cookies);
  if (response.status === 401) return { outcome: "unauthorized" };
  if (response.status !== 200) return { outcome: "not-found" };
  const summary = parseAs(
    paginatedSchema(PrincipalSummary),
    response.data,
    "principals response",
  );
  const tenantId = summary.data.find((p) => p.tenantSlug === orgSlug)?.tenantId;
  return tenantId !== undefined
    ? { outcome: "resolved", tenantId }
    : { outcome: "not-found" };
}

type ResolveResult =
  | { status: "resolved"; tenantId: string; session: Session }
  /** The session used to look up the bench is still good — just no
   * matching bench yet. Worth caching: the next tick should retry only
   * the lookup, not re-authenticate. */
  | { status: "unresolved"; session: Session };

/**
 * Runs one bench-resolution pass against a possibly-cached session:
 * reuse `session` when given (retrying only the bench lookup, never
 * re-authenticating on every tick), re-authenticating exactly once when
 * the cached cookie has gone stale (a 401 from the bench lookup). Lets
 * `signIn` itself throw uncaught — an admin account that does not exist
 * yet (or a password mismatch) is a distinct, un-cacheable failure the
 * caller must not paper over with a stale session.
 */
async function resolveWithSession(
  api: ApiCall,
  deps: EnvCredentialPlantDeps,
  cachedSession: Session | undefined,
): Promise<ResolveResult> {
  const session = cachedSession ?? (await signIn(api, deps.admin));
  const lookup = await resolveOperatorTenantId(
    api,
    session.cookies,
    deps.admin.orgSlug,
  );

  if (lookup.outcome === "resolved") {
    return { status: "resolved", tenantId: lookup.tenantId, session };
  }
  if (lookup.outcome === "not-found") {
    return { status: "unresolved", session };
  }

  // The cached cookie is stale — re-authenticate once and retry the
  // lookup with the fresh session, rather than waiting for the next
  // scheduled tick.
  const freshSession = await signIn(api, deps.admin);
  const retried = await resolveOperatorTenantId(
    api,
    freshSession.cookies,
    deps.admin.orgSlug,
  );
  return retried.outcome === "resolved"
    ? { status: "resolved", tenantId: retried.tenantId, session: freshSession }
    : { status: "unresolved", session: freshSession };
}

type AttemptResult =
  | {
      status: "ran";
      outcomes: readonly PlantEnvProviderCredentialsOutcome[];
      session: Session;
    }
  | { status: "unresolved"; session: Session };

async function attemptPlant(
  deps: EnvCredentialPlantDeps,
  cachedSession: Session | undefined,
): Promise<AttemptResult> {
  const api = createHubAPI(deps.baseUrl, localFetchImpl(deps.fetch));
  const resolved = await resolveWithSession(api, deps, cachedSession);
  if (resolved.status === "unresolved") {
    return resolved;
  }
  const plant = deps.plant ?? plantEnvProviderCredentials;
  const outcomes = await plant({
    api,
    cookies: resolved.session.cookies,
    tenantId: resolved.tenantId,
    envProviderKeys: deps.envProviderKeys,
    envProviderBaseUrls: deps.envProviderBaseUrls,
    ...(deps.envProviderPreferredModels !== undefined
      ? { envProviderPreferredModels: deps.envProviderPreferredModels }
      : {}),
    log: (line) => log.info`${line}`,
  });
  return { status: "ran", outcomes, session: resolved.session };
}

function failureReason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Fires the first plant attempt immediately (never blocking the
 * caller — the returned handle resolves independently of hub boot) and
 * keeps retrying, with exponential backoff up to `maxRetryIntervalMs`,
 * until the operator bench resolves and a plant actually runs with
 * nothing left `"blocked"`. A blocked outcome (a proven env key that
 * could not be stored because a stale credential of the same name is in
 * the way) is not treated as done — a later retry, after the operator
 * clears the stale row, can still succeed. Every other outcome —
 * planted, skipped, or a probe failure — is terminal for this run: a bad
 * key is not a reason to keep polling.
 *
 * An unresolved target that never resolves stops retrying after
 * `giveUpAfterMs` (default 24h), logging exactly one error-level line.
 * The authenticated session is cached across ticks and only
 * re-established on a 401, so a long retry window does not mint a fresh
 * session (or a fresh row) every ten seconds; the cached session is
 * dropped once the run reaches a terminal state, letting its cookie
 * lapse rather than keeping it alive with no further use.
 *
 * A no-op with no scheduled retry when no provider env key is set at
 * all, so a hub boot with nothing to plant never even attempts to sign
 * in.
 */
export function scheduleEnvProviderCredentialPlant(
  deps: EnvCredentialPlantDeps,
): { stop: () => void } {
  if (Object.keys(deps.envProviderKeys).length === 0) {
    return { stop: () => {} };
  }

  const intervalMs = deps.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const maxIntervalMs =
    deps.maxRetryIntervalMs ?? DEFAULT_MAX_RETRY_INTERVAL_MS;
  const giveUpAfterMs = deps.giveUpAfterMs ?? DEFAULT_GIVE_UP_AFTER_MS;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentIntervalMs = intervalMs;
  let lastLoggedReason: string | undefined;
  let session: Session | undefined;
  const startedAt = Date.now();

  function scheduleRetry(): void {
    if (stopped) return;
    if (Date.now() - startedAt >= giveUpAfterMs) {
      log.error`env credential plant: giving up after ${Math.round(giveUpAfterMs / 3_600_000)}h with the operator bench still unresolved (last reason: ${lastLoggedReason ?? "unknown"})`;
      session = undefined;
      return;
    }
    timer = setTimeout(() => void attempt(), currentIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
    currentIntervalMs = Math.min(currentIntervalMs * 2, maxIntervalMs);
  }

  function logUnresolved(reason: string): void {
    if (reason === lastLoggedReason) return;
    const level = lastLoggedReason === undefined ? "info" : "error";
    const message = `env credential plant: not ready yet (${reason}); will keep retrying with backoff up to ${Math.round(maxIntervalMs / 1000)}s`;
    if (level === "error") log.error`${message}`;
    else log.info`${message}`;
    lastLoggedReason = reason;
  }

  async function attempt(): Promise<void> {
    if (stopped) return;
    try {
      const result = await attemptPlant(deps, session);
      if (result.status === "unresolved") {
        session = result.session;
        logUnresolved(
          `operator bench "${deps.admin.orgSlug}" does not exist yet (or ${deps.admin.email} is not a member of it)`,
        );
        scheduleRetry();
        return;
      }
      const stillBlocked = result.outcomes.some((o) => o.status === "blocked");
      if (!stillBlocked) {
        // A run happened with nothing left blocked — done.
        session = undefined;
        return;
      }
      session = result.session;
      scheduleRetry();
    } catch (cause) {
      session = undefined;
      logUnresolved(failureReason(cause));
      scheduleRetry();
    }
  }

  void attempt();

  return {
    stop(): void {
      stopped = true;
      session = undefined;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
