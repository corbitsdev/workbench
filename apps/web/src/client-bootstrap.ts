// The portable client bootstrap: one call that drives the client's
// needs-list against a stock Interchange hub using only stock routes — no
// workbench server proxies, tables, or mounts. Auth owns the primary
// tenant; this lane converges everything beneath it (top-level Myra,
// workbench child tenants plus each workbench's primary thread) and
// persists the child tenant ids it created in client storage scoped by
// hub origin and account, so a reinstall reclaims by id, never by slug.
// DMs are participant-filtered threads derived client-side, never tenants.
// Myra's definition refId resolves from the client workflow catalog, and
// deployment source/offering ids only ever come from explicit caller
// config — this module never guesses them. When stock Interchange lacks a
// capability the result carries the typed gap instead of throwing.

import { WORKFLOW_CATALOG } from "@workbench/templates";

import type { ClientLogger } from "@corbits/client-log";

import {
  buildNeedsList,
  childTenantStore,
  type StringStorage,
  type WorkflowDeployInput,
} from "./needs-list";
import {
  convergeNeedsList,
  createFetchStockHub,
  findOwnedTenants,
  StockHubCapabilityError,
  StockHubRequestError,
  type PrimaryThread,
  type StockHub,
  type StockHubCapability,
} from "./needs-converge";

/** Derives a stable, readable slug for the primary tenant this account is
 * about to mint — never random, so a retry after a dropped response
 * targets the same slug rather than minting a second root. */
function primaryTenantSlug(account: ClientBootstrapAccount): string {
  const base = account.email
    .split("@")[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base !== undefined && base.length > 0 ? base : `home-${account.id}`;
}

/** First-signup installer step (CL-8131): mints the account's primary
 * tenant over the stock `POST /api/tenants` route (no `parentId`, so the
 * caller becomes its owner) when it does not already own one. This is
 * the "0→1" ruling's execution — never hub boot, never a CLI — and it
 * never mints a second root: an account that already owns a top-level
 * tenant is left alone. */
export async function ensurePrimaryTenant(
  account: ClientBootstrapAccount,
  hub: StockHub,
): Promise<void> {
  const owned = await findOwnedTenants(hub);
  if (owned.some((tenant) => tenant.parentId === null)) return;
  await hub.createTenant({
    name: `${account.name}'s Workbench`,
    slug: primaryTenantSlug(account),
  });
}

/** The seeded assistant asset, productized as Myra — the same wire
 * identifier the hub seed deploys under and the catalog resolves to the
 * "Myra" display name. Resolved from the catalog at runtime, never
 * hardcoded at the call site. */
export function resolveMyraDefinitionRefId(): string | undefined {
  return WORKFLOW_CATALOG.find((entry) => entry.displayName === "Myra")
    ?.assetName;
}

export type ClientBootstrapAccount = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
};

export type ClientBootstrapDeps = {
  readonly hub: StockHub;
  readonly storage: StringStorage;
  /** The hub origin this browser talks to — scopes persisted ids per hub. */
  readonly hubScope: string;
  /** Override for the catalog-resolved Myra definition refId. */
  readonly myraDefinitionRefId?: string;
  /** Exact stock deployment inputs for Myra when she is absent. Caller
   * config only — never synthesized here. */
  readonly myraDeploy?: WorkflowDeployInput;
};

export type ClientBootstrapResult =
  | {
      readonly kind: "ready";
      readonly primaryTenantId: string;
      readonly createdTenantIds: readonly string[];
      readonly primaryThreads: readonly PrimaryThread[];
    }
  | {
      readonly kind: "error";
      readonly code: "stock-capability-missing";
      readonly capability: StockHubCapability;
      readonly message: string;
      /** What stock Interchange cannot do yet, in operator language. */
      readonly gap: string;
    }
  | {
      readonly kind: "error";
      readonly code: "stock-hub-request-failed";
      readonly operation: string;
      readonly status: number | undefined;
      readonly message: string;
    }
  | {
      readonly kind: "error";
      readonly code: "client-config-missing";
      readonly message: string;
    };

/** Operator-language note per missing stock capability — the reason a
 * convergence stops, and what has to change upstream before it can
 * proceed. Surfaced alongside the typed error, never a silent skip. */
export const UPSTREAM_GAP_NOTES: Record<StockHubCapability, string> = {
  "primary-tenant-bootstrap":
    "Sign-in is expected to leave exactly one owned top-level home behind, but this session shows zero or several.",
  "deploy-workflow-inputs":
    "Myra is absent and the client was not given the exact stock source and offering ids — supply myraDeploy from client config.",
  "project-workflow-principal":
    "Stock Interchange cannot carry a workflow identity into a child room by refId, so workbench member setup waits on an upstream capability.",
  "principal-roles":
    "The stock member invite route cannot assign the requested child-room roles.",
  "agent-mailbox-reads":
    "Stock Interchange exposes no per-agent mailbox search, so participant-filtered thread derivation waits on a stock search route.",
  "thread-fork-context":
    "Stock Interchange exposes no full thread read, so sub-thread fork context waits on a stock thread route.",
};

export async function bootstrapClientSession(
  account: ClientBootstrapAccount,
  deps: ClientBootstrapDeps,
): Promise<ClientBootstrapResult> {
  const myraDefinitionRefId =
    deps.myraDefinitionRefId ?? resolveMyraDefinitionRefId();
  if (myraDefinitionRefId === undefined) {
    return {
      kind: "error",
      code: "client-config-missing",
      message:
        "The client catalog names no Myra workflow entry, so the bootstrap cannot identify the top-level Myra.",
    };
  }
  const manifest = buildNeedsList({
    account: { id: account.id, name: account.name, email: account.email },
    myraDefinitionRefId,
    ...(deps.myraDeploy === undefined ? {} : { myraDeploy: deps.myraDeploy }),
  });
  const store = childTenantStore(deps.storage, deps.hubScope, account.id);
  try {
    // The common case (an account that already owns its primary tenant)
    // never pays for a primary-tenant existence probe: convergence is
    // attempted directly, and only a "primary-tenant-bootstrap" gap — the
    // first-signup case — triggers the one-time mint-then-retry below.
    const report = await convergeNeedsList(manifest, deps.hub, store).catch(
      async (cause: unknown) => {
        if (
          !(cause instanceof StockHubCapabilityError) ||
          cause.capability !== "primary-tenant-bootstrap"
        ) {
          throw cause;
        }
        await ensurePrimaryTenant(account, deps.hub);
        return convergeNeedsList(manifest, deps.hub, store);
      },
    );
    return {
      kind: "ready",
      primaryTenantId: report.primaryTenantId,
      createdTenantIds: report.createdTenantIds,
      primaryThreads: report.primaryThreads,
    };
  } catch (cause) {
    if (cause instanceof StockHubCapabilityError) {
      return {
        kind: "error",
        code: "stock-capability-missing",
        capability: cause.capability,
        message: cause.message,
        gap: UPSTREAM_GAP_NOTES[cause.capability],
      };
    }
    if (cause instanceof StockHubRequestError) {
      return {
        kind: "error",
        code: "stock-hub-request-failed",
        operation: cause.operation,
        status: cause.status,
        message: cause.message,
      };
    }
    throw cause;
  }
}

/** One shared landing for the bootstrap outcome at both entry points
 * (first-open in main, signup in the onboarding page): a converged lane
 * logs at info, a stock gap or any other failure logs at warn — never
 * shown, never gating the shell. */
export function logBootstrapResult(
  log: ClientLogger,
  result: ClientBootstrapResult,
): void {
  if (result.kind === "ready") {
    log.info("Portable client bootstrap converged", {
      primaryTenantId: result.primaryTenantId,
      createdTenantIds: [...result.createdTenantIds],
    });
  } else if (result.code === "stock-capability-missing") {
    log.warn("Portable client bootstrap waiting on stock capability", {
      capability: result.capability,
      gap: result.gap,
    });
  } else {
    log.warn("Portable client bootstrap failed", {
      message: result.message,
    });
  }
}

/** The thrown twin of logBootstrapResult — a bootstrap that rejects (rather
 * than returning a typed error) is logged, never surfaced. */
export function logBootstrapThrown(log: ClientLogger, error: unknown): void {
  log.warn("Portable client bootstrap threw", {
    message: error instanceof Error ? error.message : String(error),
  });
}

/** The bootstrap with its production ports already attached: stock fetch
 * hub, browser localStorage, current origin as hub scope. Both bootstrap
 * entry points (first-open in main, signup in the onboarding page) call
 * this one helper so the ports can never drift between them. */
export function runPortableClientBootstrap(
  account: ClientBootstrapAccount,
  overrides?: {
    readonly myraDefinitionRefId?: string;
    readonly myraDeploy?: WorkflowDeployInput;
  },
): Promise<ClientBootstrapResult> {
  return bootstrapClientSession(account, {
    hub: createFetchStockHub(),
    storage: localStorage,
    hubScope: window.location.origin,
    ...(overrides?.myraDefinitionRefId === undefined
      ? {}
      : { myraDefinitionRefId: overrides.myraDefinitionRefId }),
    ...(overrides?.myraDeploy === undefined
      ? {}
      : { myraDeploy: overrides.myraDeploy }),
  });
}
