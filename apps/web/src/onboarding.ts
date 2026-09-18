// The browser side of the first-login hook: a read-only probe that never
// mints anything. Setup counts as done only once the primary tenant has
// Myra live, so an install that failed midway resumes instead of landing
// in an empty shell.

import { type } from "arktype";
import { reportError } from "@corbits/error-sink";
import { MYRA_SOURCE_CONFIG } from "./myra-source";
import { createFetchStockHub, findOwnedTenants, type StockHub } from "./needs-converge";

// The cheap pre-skip read to tell "no credential yet" apart from "still
// coming online".
const CredentialsPage = type({
  data: type({ status: "string" }).array(),
});

// A probe that can't complete is never collapsed into `none`: that would
// open paste-a-key as if no key exists when one may already be connected.
export type ActiveCredentialProbe =
  | { readonly kind: "active" }
  | { readonly kind: "none" }
  | { readonly kind: "error" };

// A cheap, single read, no chain resolution — only a confirmed miss
// means "no key", never a probe failure.
export async function hasActiveCredential(tenantId: string): Promise<ActiveCredentialProbe> {
  try {
    const response = await fetch(`/api/tenants/${tenantId}/credentials`);
    if (!response.ok) return { kind: "error" };
    const body: unknown = await response.json().catch(() => null);
    const parsed = CredentialsPage(body);
    if (parsed instanceof type.errors) return { kind: "error" };
    return parsed.data.some((c) => c.status === "active") ? { kind: "active" } : { kind: "none" };
  } catch {
    return { kind: "error" };
  }
}

// The hub's user-facing error envelope: `userMessage` is
// consumer language, safe to render as-is; `refId` is what a person can
// quote back for support. Never a raw `message`/stack/file-path field —
// those stay in the hub's own logger.
const ErrorEnvelope = type({
  error: { code: "string", userMessage: "string", refId: "string" },
});

const FALLBACK_ERROR_MESSAGE =
  "Setting up your workbench hit a snag — we're on it. Try again in a moment.";

// Seed/credential detail belongs to the setup flow, not this routing
// decision — the hook needs only the verdict.
export type ProvisionOutcome =
  | { readonly kind: "existing-member" }
  | { readonly kind: "needs-onboarding" }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly refId?: string;
    };

export async function triggerFirstLoginProvisioning(
  hub: StockHub = createFetchStockHub(),
): Promise<ProvisionOutcome> {
  try {
    const owned = await findOwnedTenants(hub);
    const primary = owned.find((tenant) => tenant.parentId === null);
    if (primary === undefined) return { kind: "needs-onboarding" };
    const deployed = await hub.hasWorkflowDeployment(primary.id, MYRA_SOURCE_CONFIG.assetName);
    return deployed ? { kind: "existing-member" } : { kind: "needs-onboarding" };
  } catch (cause) {
    const refId = reportError(cause, { operation: "first_login_provisioning" });
    return { kind: "error", message: FALLBACK_ERROR_MESSAGE, refId };
  }
}

// The agent-readiness tombstone below exists only to keep the deleted
// `/api/onboarding/*` route's absence explicit — a 404/410 is
// `route-gone`, never a generic agent error.
const ProvisioningStatus = type({
  kind: "'ready' | 'provisioning'",
  setupAgentReady: "boolean",
});

// Deliberately not a count: how many workflows a bench seeds is an
// implementation detail a person watching "0 of 5" can't act on.
export type AgentReadiness =
  | { readonly kind: "ready" }
  | { readonly kind: "chat-ready" }
  | { readonly kind: "preparing" }
  | { readonly kind: "route-gone" }
  | { readonly kind: "error"; readonly message: string };

// No live caller uses this — kept so the deleted route's absence stays
// an explicit, testable outcome.
export async function fetchAgentReadiness(tenantId: string): Promise<AgentReadiness> {
  try {
    const response = await fetch(
      `/api/onboarding/provisioning-status?${new URLSearchParams({ tenantId })}`,
    );
    if (response.status === 404 || response.status === 410) {
      return { kind: "route-gone" };
    }
    const body: unknown = await response.json();
    if (!response.ok) {
      const envelope = ErrorEnvelope(body);
      if (!(envelope instanceof type.errors)) {
        return {
          kind: "error",
          message: `${envelope.error.userMessage} Reference: ${envelope.error.refId}`,
        };
      }
      throw new Error(`Agent readiness request failed (${response.status})`);
    }
    const parsed = ProvisioningStatus(body);
    if (parsed instanceof type.errors) throw new Error("Invalid agent readiness response");
    if (parsed.kind === "ready") return { kind: "ready" };
    return parsed.setupAgentReady ? { kind: "chat-ready" } : { kind: "preparing" };
  } catch (cause) {
    const refId = reportError(cause, {
      operation: "agent_readiness",
      tenantId,
    });
    return {
      kind: "error",
      message: `Couldn't check your agent. Try again. Reference: ${refId}`,
    };
  }
}
