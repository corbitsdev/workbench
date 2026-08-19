// The memory settings status contract: what the settings UI renders
// without re-deriving any product decision itself. `source` carries the
// precedence step that won — "env", or "lexical-only" (the floor:
// full-text search only, needs nothing beyond the hub's own
// pgvector-capable Postgres) — so a future third source slots in as one
// more value here, never a reshape.
//
// Also mounts the tenant-scoped, read-only status route itself —
// `GET /api/tenants/:tenantId/memory/status` — guarded on the `"memory"`
// resource, `packages/connections`' `requireGrant("credential:*", "read")`
// sibling in spirit. The action is `"status"`, not `"read"` and not one of
// `@corbits/memory`'s own `MEMORY_GRANT_REQUIREMENTS` actions
// (`add`/`search`/`forget`/`purge`) — this is a workbench-owned action for
// "can see whether the plane is configured," deliberately distinct from the
// authority to search or mutate a tenant's memories. This ticket ships no
// config-write route.
import { Hono } from "hono";
import type { Context } from "hono";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import type {
  DegradeMetricsSnapshot,
  MemoryCapabilities,
  MemoryConfig,
} from "@corbits/memory";

import type { MemoryConfigSource } from "./memory-config";

export type MemoryEmbedStatus = {
  readonly model: string;
  /** Host only — e.g. "api.openai.com". Never a full URL (which could carry
   * a query-string credential) and never the API key itself. */
  readonly host: string;
};

export type MemoryRerankStatus =
  | { readonly configured: true; readonly model: string; readonly host: string }
  | { readonly configured: false };

export type MemorySetupOption =
  | {
      readonly kind: "set-env";
      readonly label: string;
      readonly envVars: readonly string[];
    }
  | {
      readonly kind: "lexical-only";
      readonly label: string;
      /** e.g. "No embeddings account needed — this deploy's Postgres already
       * has pgvector, which full-text search still relies on." Framed as a
       * real, honest option (not "no setup needed"): pgvector remains a
       * requirement, dense embeddings are simply not one. */
      readonly caveat: string;
    };

export type MemoryDegradeStatus = {
  readonly totalSearches: number;
  readonly since: string;
  readonly windowSize: number;
  readonly windowedDegradeRate: Record<string, number>;
  readonly escalated: Record<string, boolean>;
};

/**
 * The memory plane is always available once it builds (lexical-only is a
 * legitimate, fully-capable mode, not a degraded one) — `embeddingsConfigured`
 * is the plane's own construction-time answer (`Memory.capabilities`,
 * `@corbits/memory`'s CL-6287 addition), never re-derived from config here.
 * `missing`/`setupOptions` describe how to move from lexical-only up to
 * dense retrieval; both are empty once it's already active.
 */
export type MemoryPlaneStatus = {
  readonly source: MemoryConfigSource;
  readonly embeddingsConfigured: boolean;
  readonly embed: MemoryEmbedStatus | null;
  readonly rerank: MemoryRerankStatus;
  readonly degrade: MemoryDegradeStatus;
  readonly missing: readonly string[];
  readonly setupOptions: readonly MemorySetupOption[];
};

/** Host only (e.g. "api.openai.com") — never the full URL, which could
 * carry a query-string credential, and never the key itself. Falls back to
 * the raw string for a value that isn't a real URL rather than throwing —
 * status reporting must never fail because of what it's reporting on. */
export function hostOnly(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export const MEMORY_SETUP_OPTIONS: readonly MemorySetupOption[] = [
  {
    kind: "set-env",
    label: "Set an embedding endpoint for this deploy",
    envVars: ["EMBED_BASE_URL", "EMBED_MODEL"],
  },
  {
    kind: "lexical-only",
    label: "Stay on full-text search (lexical-only)",
    caveat:
      "No embeddings account needed — this deploy's Postgres already has " +
      "the pgvector-capable database full-text search relies on.",
  },
];

function rerankStatusFrom(config: MemoryConfig): MemoryRerankStatus {
  const { rerank } = config.memory;
  if (rerank.baseUrl === undefined || rerank.model === undefined) {
    return { configured: false };
  }
  return {
    configured: true,
    model: rerank.model,
    host: hostOnly(rerank.baseUrl),
  };
}

/** Builds the full contract from a resolved config, the real built plane's
 * own capabilities, and this tenant's degrade snapshot. Pure — no I/O — so
 * the lazy-plane module (the only caller with a real `Memory` and a real
 * snapshot function) stays the one place that decides when to call it. */
export function buildMemoryPlaneStatus(
  source: MemoryConfigSource,
  config: MemoryConfig,
  capabilities: MemoryCapabilities,
  degrade: DegradeMetricsSnapshot,
): MemoryPlaneStatus {
  const { embeddingsConfigured } = capabilities;
  return {
    source,
    embeddingsConfigured,
    embed:
      embeddingsConfigured && config.memory.embed !== undefined
        ? {
            model: config.memory.embed.model,
            host: hostOnly(config.memory.embed.baseUrl),
          }
        : null,
    rerank: rerankStatusFrom(config),
    degrade: {
      totalSearches: degrade.totalSearches,
      since: degrade.since.toISOString(),
      windowSize: degrade.windowSize,
      windowedDegradeRate: degrade.windowedDegradeRate,
      escalated: degrade.escalated,
    },
    missing: embeddingsConfigured
      ? []
      : ["a dense embedding endpoint — set one for this deploy"],
    setupOptions: embeddingsConfigured ? [] : MEMORY_SETUP_OPTIONS,
  };
}

/**
 * Why this caller has no memory of their own, when they don't. Memory
 * belongs to the org tenant and a caller reaches it through their own
 * principal there (`./memory-mount.ts`'s caller resolver), so there are
 * exactly three ways to hold none:
 *
 *   - `no-org-principal` — a guest invited into a single workbench whose own
 *     parent tenancy is elsewhere. The correct default in both directions:
 *     the host's memory is not exposed to them, and theirs is not exposed to
 *     the host.
 *   - `no-account-tenant` — the caller's own tenant IS the operator tenant,
 *     so there is no account beneath it to keep memories under.
 *   - `not-a-person` — the caller is not a `kind: "user"` principal. A run
 *     reaches memory through the grants written onto it at launch, never
 *     through this browser surface.
 */
export type MemoryUnscopedReason =
  "no-org-principal" | "no-account-tenant" | "not-a-person";

export type MemoryCallerScope =
  | { readonly kind: "scoped" }
  | { readonly kind: "unscoped"; readonly reason: MemoryUnscopedReason };

/**
 * What `GET /status` answers with: the plane's own facts, and whether this
 * caller has any memory in it. The two are independent — a fully configured
 * plane still holds nothing for a guest — so they stay separate fields
 * rather than one flattened shape that would make the page guess.
 */
export type MemoryStatusResponse = {
  /**
   * `null` for a caller who holds no memory here. The plane's facts are
   * about a store this caller has no reach into, and describing it would
   * mean resolving an account tenant they may not have.
   */
  readonly plane: MemoryPlaneStatus | null;
  readonly caller: MemoryCallerScope;
};

export type MemoryStatusPlane = {
  describeStatus(tenantId: string): Promise<MemoryPlaneStatus>;
};

export type MemoryStatusRouteDeps = {
  readonly plane: MemoryStatusPlane;
  readonly requireGrant: RequireGrant;
  /**
   * Runs the same resolution every memory data route runs, so the page's
   * explanation can never disagree with what a search would actually do.
   */
  readonly describeCaller: (
    c: Context<TenantEnv>,
  ) => Promise<MemoryCallerScope>;
};

export function createMemoryStatusRoutes(
  deps: MemoryStatusRouteDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  app.get(
    "/status",
    // A fail-closed safety net for a mis-mounted host or a unit test that
    // never ran the host's own tenant middleware — `requireGrant` reads
    // `principal.id` with no guard of its own, matching
    // `@corbits/memory`'s own `requirePrincipal` convention.
    async (c, next) => {
      if (!c.get("principal") || !c.get("tenant")) {
        return c.json(
          {
            error: {
              code: "principal_required",
              message:
                "No principal on the request context. Mount memory under " +
                "the host's tenant-session middleware.",
            },
          },
          401,
        );
      }
      await next();
    },
    // "status" is a workbench-owned action on the `memory` resource — it is
    // NOT one of `@corbits/memory`'s own `MEMORY_GRANT_REQUIREMENTS`
    // (`add`/`search`/`forget`/`purge`), and granting one of those four to
    // read this route would be a real over-grant: reading whether the
    // plane is configured is not the same authority as searching or
    // mutating a tenant's memories. Seeded onto every tenant's own
    // principal by `packages/hub-client/src/seed.ts`'s `SEED_GRANTS` (which
    // `@workbench/onboarding`'s self-serve provisioning also runs through),
    // never invented ad hoc per caller.
    deps.requireGrant("memory", "status"),
    async (c) => {
      // The caller first, and the plane only if they have one. Describing
      // the plane means resolving the caller's account tenant, which throws
      // for the one caller whose own tenant IS the operator tenant — the
      // exact caller whose scope is `no-account-tenant`. Asking the plane
      // first turned that person's explanation into a 500 and put the
      // operator-fault copy in front of them.
      const caller = await deps.describeCaller(c);
      if (caller.kind === "unscoped") {
        return c.json({ plane: null, caller } satisfies MemoryStatusResponse);
      }
      const tenant = c.get("tenant");
      const plane = await deps.plane.describeStatus(tenant.id);
      return c.json({ plane, caller } satisfies MemoryStatusResponse);
    },
  );
  return app;
}
