// CL-6344: schedules the bench-library template seed at hub boot. The
// hub, as the operator's admin principal, plants the shipped workbench
// template manifests into the bench's library (see
// `@corbits/artifacts-hub`'s `seedTemplateLibrary` — idempotent, so a
// second boot changes nothing) and publishes the `@corbits/*` tool
// tarballs those templates' workflows pin (reusing
// `@corbits/tool-registry-publish`, which already skips
// already-published filenames), so instantiating a template never
// resolves against a registry the bench doesn't have yet.
//
// Target resolution, retry cadence, and the sign-in-only rule all
// mirror `./env-credential-plant.ts`: sign in as the configured admin
// (never sign up), find the bench named ORG_SLUG among that account's
// memberships, retry with backoff while it doesn't exist yet, and
// never block or fail hub boot.

import { getLogger } from "@intx/log";
import { paginatedSchema, PrincipalSummary } from "@intx/types";
import type { ArtifactDb } from "@corbits/artifacts";
import {
  seedTemplateLibrary,
  type TemplateLibraryEntry,
} from "@corbits/artifacts-hub";
import {
  publishCorbitsToolsRegistry,
  type PublishCorbitsToolsRegistryArgs,
} from "@corbits/tool-registry-publish";
import {
  signIn,
  createHubAPI,
  parseAs,
  type ApiCall,
  type Session,
} from "@workbench/hub-client";
import type { HubConfig } from "./config";

const DEFAULT_RETRY_INTERVAL_MS = 10_000;
const DEFAULT_MAX_RETRY_INTERVAL_MS = 5 * 60_000;
const DEFAULT_GIVE_UP_AFTER_MS = 24 * 60 * 60_000;

const log = getLogger(["hub", "template-library-seed"]);

export type TemplateLibrarySeedDeps = {
  baseUrl: string;
  admin: HubConfig["envCredentialPlantAdmin"];
  /** The fully composed, guarded app's own request entry point. */
  fetch: (request: Request) => Promise<Response>;
  artifactsDb: ArtifactDb;
  entries: readonly TemplateLibraryEntry[];
  retryIntervalMs?: number;
  maxRetryIntervalMs?: number;
  giveUpAfterMs?: number;
  /** Test seams, replacing the real library seed and tarball publish. */
  seed?: typeof seedTemplateLibrary;
  publishTools?: (args: PublishCorbitsToolsRegistryArgs) => Promise<unknown>;
};

function localFetchImpl(
  entry: (request: Request) => Promise<Response>,
): typeof fetch {
  return ((input, init) =>
    entry(new Request(input as string, init as RequestInit))) as typeof fetch;
}

type BenchTarget = { tenantId: string; principalId: string };

async function lookUpBench(
  api: ApiCall,
  cookies: string[],
  orgSlug: string,
): Promise<BenchTarget | "unauthorized" | "not-found"> {
  const response = await api("GET", "/api/me/principals", undefined, cookies);
  if (response.status === 401) return "unauthorized";
  if (response.status !== 200) return "not-found";
  const summary = parseAs(
    paginatedSchema(PrincipalSummary),
    response.data,
    "principals response",
  );
  const membership = summary.data.find((p) => p.tenantSlug === orgSlug);
  return membership !== undefined
    ? { tenantId: membership.tenantId, principalId: membership.principalId }
    : "not-found";
}

type ResolveResult =
  | { status: "resolved"; target: BenchTarget; session: Session }
  | { status: "unresolved"; session: Session };

async function resolveWithSession(
  api: ApiCall,
  deps: TemplateLibrarySeedDeps,
  cachedSession: Session | undefined,
): Promise<ResolveResult> {
  const session = cachedSession ?? (await signIn(api, deps.admin));
  const lookup = await lookUpBench(api, session.cookies, deps.admin.orgSlug);
  if (lookup !== "unauthorized") {
    return lookup === "not-found"
      ? { status: "unresolved", session }
      : { status: "resolved", target: lookup, session };
  }
  // Stale cookie — re-authenticate once rather than waiting a full tick.
  const freshSession = await signIn(api, deps.admin);
  const retried = await lookUpBench(
    api,
    freshSession.cookies,
    deps.admin.orgSlug,
  );
  return retried === "unauthorized" || retried === "not-found"
    ? { status: "unresolved", session: freshSession }
    : { status: "resolved", target: retried, session: freshSession };
}

/**
 * Fires the first seed attempt immediately (never blocking the caller)
 * and keeps retrying with exponential backoff until the operator bench
 * resolves and one full seed pass (library entries + tool tarballs)
 * completes. Both halves are idempotent, so a retry after a partial
 * failure redoes only what's missing.
 */
export function scheduleTemplateLibrarySeed(deps: TemplateLibrarySeedDeps): {
  stop: () => void;
} {
  if (deps.entries.length === 0) {
    return { stop: () => {} };
  }

  const intervalMs = deps.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const maxIntervalMs =
    deps.maxRetryIntervalMs ?? DEFAULT_MAX_RETRY_INTERVAL_MS;
  const giveUpAfterMs = deps.giveUpAfterMs ?? DEFAULT_GIVE_UP_AFTER_MS;
  const seed = deps.seed ?? seedTemplateLibrary;
  const publishTools = deps.publishTools ?? publishCorbitsToolsRegistry;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentIntervalMs = intervalMs;
  let lastLoggedReason: string | undefined;
  let session: Session | undefined;
  const startedAt = Date.now();

  function scheduleRetry(): void {
    if (stopped) return;
    if (Date.now() - startedAt >= giveUpAfterMs) {
      log.error`template library seed: giving up after ${Math.round(giveUpAfterMs / 3_600_000)}h with the operator bench still unresolved (last reason: ${lastLoggedReason ?? "unknown"})`;
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
    const message = `template library seed: not ready yet (${reason}); will keep retrying with backoff up to ${Math.round(maxIntervalMs / 1000)}s`;
    if (level === "error") log.error`${message}`;
    else log.info`${message}`;
    lastLoggedReason = reason;
  }

  async function attempt(): Promise<void> {
    if (stopped) return;
    const api = createHubAPI(deps.baseUrl, localFetchImpl(deps.fetch));
    try {
      const resolved = await resolveWithSession(api, deps, session);
      if (resolved.status === "unresolved") {
        session = resolved.session;
        logUnresolved(
          `operator bench "${deps.admin.orgSlug}" does not exist yet (or ${deps.admin.email} is not a member of it)`,
        );
        scheduleRetry();
        return;
      }
      const outcomes = await seed({
        db: deps.artifactsDb,
        scope: {
          tenantId: resolved.target.tenantId,
          principalId: resolved.target.principalId,
        },
        entries: deps.entries,
      });
      for (const outcome of outcomes) {
        log.info`template library seed: "${outcome.id}" ${outcome.outcome}`;
      }
      await publishTools({
        api,
        cookies: resolved.session.cookies,
        hubUrl: deps.baseUrl,
        tenantId: resolved.target.tenantId,
        fetchImpl: localFetchImpl(deps.fetch),
        log: (line) => log.info`${line}`,
      });
      session = undefined;
    } catch (cause) {
      session = undefined;
      logUnresolved(cause instanceof Error ? cause.message : String(cause));
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
