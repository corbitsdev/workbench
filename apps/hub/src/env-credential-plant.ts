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
// an unresolved target is retried on a plain interval until it
// resolves; the retry itself is logged only once, never on every tick.
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
  authenticate,
  createHubAPI,
  parseAs,
  type ApiCall,
} from "@workbench/hub-client";
import {
  plantEnvProviderCredentials,
  type PlantEnvProviderCredentialsOutcome,
} from "@workbench/onboarding";
import type { HubConfig } from "./config";

const DEFAULT_RETRY_INTERVAL_MS = 10_000;

const log = getLogger(["hub", "env-credential-plant"]);

export type EnvCredentialPlantDeps = {
  baseUrl: string;
  envProviderKeys: HubConfig["envProviderKeys"];
  admin: HubConfig["envCredentialPlantAdmin"];
  /** The fully composed, guarded app's own request entry point. */
  fetch: (request: Request) => Promise<Response>;
  retryIntervalMs?: number;
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

async function resolveOperatorTenantId(
  api: ApiCall,
  cookies: string[],
  orgSlug: string,
): Promise<string | undefined> {
  const response = await api("GET", "/api/me/principals", undefined, cookies);
  if (response.status !== 200) return undefined;
  const summary = parseAs(
    paginatedSchema(PrincipalSummary),
    response.data,
    "principals response",
  );
  return summary.data.find((p) => p.tenantSlug === orgSlug)?.tenantId;
}

async function attemptPlant(
  deps: EnvCredentialPlantDeps,
): Promise<readonly PlantEnvProviderCredentialsOutcome[]> {
  const api = createHubAPI(deps.baseUrl, localFetchImpl(deps.fetch));
  const session = await authenticate(api, {
    email: deps.admin.email,
    password: deps.admin.password,
  });
  const tenantId = await resolveOperatorTenantId(
    api,
    session.cookies,
    deps.admin.orgSlug,
  );
  if (tenantId === undefined) {
    throw new Error(
      `operator bench "${deps.admin.orgSlug}" does not exist yet (or ${deps.admin.email} is not a member of it)`,
    );
  }
  const plant = deps.plant ?? plantEnvProviderCredentials;
  return plant({
    api,
    cookies: session.cookies,
    tenantId,
    envProviderKeys: deps.envProviderKeys,
    log: (line) => log.info`${line}`,
  });
}

/**
 * Fires the first plant attempt immediately (never blocking the
 * caller — the returned handle resolves independently of hub boot) and
 * keeps retrying on `retryIntervalMs` until the operator bench resolves
 * and a plant actually runs. Once `plantEnvProviderCredentials` runs at
 * all — regardless of whether it planted, skipped, or reported a probe
 * failure for any individual provider — this stops: a bad key is a
 * terminal outcome for this run, not a reason to keep polling. A no-op
 * with no scheduled retry when no provider env key is set at all, so a
 * hub boot with nothing to plant never even attempts to sign in.
 */
export function scheduleEnvProviderCredentialPlant(
  deps: EnvCredentialPlantDeps,
): { stop: () => void } {
  if (Object.keys(deps.envProviderKeys).length === 0) {
    return { stop: () => {} };
  }

  const intervalMs = deps.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loggedUnresolved = false;

  function scheduleRetry(): void {
    if (stopped) return;
    timer = setTimeout(() => void attempt(), intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  async function attempt(): Promise<void> {
    if (stopped) return;
    try {
      await attemptPlant(deps);
      // A run happened — done, whatever its per-provider outcomes.
    } catch (cause) {
      if (!loggedUnresolved) {
        log.info`env credential plant: not ready yet (${cause instanceof Error ? cause.message : String(cause)}); will keep retrying every ${Math.round(intervalMs / 1000)}s`;
        loggedUnresolved = true;
      }
      scheduleRetry();
    }
  }

  void attempt();

  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
