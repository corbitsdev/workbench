// The browser side of the first-login hook: one GET against the hub's
// native setup-status route, made once per session. A hub with zero
// tenants reports setup-required so the UI routes into the setup wizard;
// any tenant means a bench exists and the shell loads normally. Read-only
// on purpose (CL-8112): provisioning itself back onto the hub is T6/T7's
// surface, so this never mints anything — a broken status read blocks the
// shell loudly rather than leaving the user silently benchless.

import { type } from "arktype";
import { reportError } from "@corbits/error-sink";

const SetupStatus = type({
  setupRequired: "boolean",
  "userCount?": "number",
  "tenantCount?": "number",
});

/** Any credential row this bench actually has stored — the cheap
 * pre-skip read the home page's first-workbench flow uses to tell "no
 * credential yet" apart from "still coming online". */
const CredentialsPage = type({
  data: type({ status: "string" }).array(),
});

/**
 * Outcome of the cheap credentials read used before trusting a
 * `seeded: true` hard-skip. A probe that cannot complete is never
 * collapsed into `none` (CL-6868): that would open paste-a-key as if no
 * key exists when one may already be connected.
 */
export type ActiveCredentialProbe =
  | { readonly kind: "active" }
  | { readonly kind: "none" }
  | { readonly kind: "error" };

/**
 * Whether `tenantId` has at least one credential in the `active`
 * status. A cheap, single read — no provider/catalog chain resolution —
 * so the caller treats it as the weaker check it is: only a confirmed
 * miss means "no key", never a probe failure (CL-6868).
 */
export async function hasActiveCredential(
  tenantId: string,
): Promise<ActiveCredentialProbe> {
  try {
    const response = await fetch(`/api/tenants/${tenantId}/credentials`);
    if (!response.ok) return { kind: "error" };
    const body: unknown = await response.json().catch(() => null);
    const parsed = CredentialsPage(body);
    if (parsed instanceof type.errors) return { kind: "error" };
    return parsed.data.some((c) => c.status === "active")
      ? { kind: "active" }
      : { kind: "none" };
  } catch {
    return { kind: "error" };
  }
}

// The hub's user-facing error envelope (CL-6360): `userMessage` is
// consumer language, safe to render as-is; `refId` is what a person can
// quote back for support. Never a raw `message`/stack/file-path field —
// those stay in the hub's own logger.
const ErrorEnvelope = type({
  error: { code: "string", userMessage: "string", refId: "string" },
});

const FALLBACK_ERROR_MESSAGE =
  "Setting up your workbench hit a snag — we're on it. Try again in a moment.";

/** What the first-login hook can conclude from the native status read:
 * the account either lands on an already-set-up hub (`existing-member`)
 * or on one that still needs setup (`needs-onboarding`). The hub's own
 * counts ride along in the status payload but the hook needs only the
 * verdict — seed/credential detail belongs to the setup flow (T6/T7),
 * not to this routing decision. */
export type ProvisionOutcome =
  | { readonly kind: "existing-member" }
  | { readonly kind: "needs-onboarding" }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly refId?: string;
    };

export async function triggerFirstLoginProvisioning(): Promise<ProvisionOutcome> {
  try {
    const response = await fetch("/api/setup/status");
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const envelope = ErrorEnvelope(body);
      return envelope instanceof type.errors
        ? { kind: "error", message: FALLBACK_ERROR_MESSAGE }
        : {
            kind: "error",
            message: envelope.error.userMessage,
            refId: envelope.error.refId,
          };
    }
    const parsed = SetupStatus(body);
    if (parsed instanceof type.errors) {
      return { kind: "error", message: FALLBACK_ERROR_MESSAGE };
    }
    return parsed.setupRequired
      ? { kind: "needs-onboarding" }
      : { kind: "existing-member" };
  } catch {
    return { kind: "error", message: FALLBACK_ERROR_MESSAGE };
  }
}

/* CL-8112 cut the rest of this module's provisioning surface: the
 * credential-submit, one-click OAuth connect, and complete-setup helpers
 * all spoke to the deleted `/api/onboarding/*` routes, so they went with
 * the hub mount. What remains is the first-login status read above and
 * the agent-readiness read below (still used by the home page's
 * first-workbench flow) — the setup flow itself is T6/T7's to build. */
const ProvisioningStatus = type({
  kind: "'ready' | 'provisioning'",
  setupAgentReady: "boolean",
});

/**
 * Whether this account can start a conversation yet, and whether
 * anything is still coming online behind it (CL-6462). Deliberately not
 * a count: how many workflows a bench seeds is an implementation detail,
 * and a person watching "0 of 5" learns nothing they can act on.
 *
 * - `ready` — everything this bench seeds is live.
 * - `chat-ready` — Myra is live, so the person can start now; the rest
 *   converge in the background.
 * - `preparing` — Myra is not live yet; this is the only state worth
 *   holding someone on a loader for.
 * - `error` — readiness could not be checked; show the message and allow retry.
 */
export type AgentReadiness =
  | { readonly kind: "ready" }
  | { readonly kind: "chat-ready" }
  | { readonly kind: "preparing" }
  | { readonly kind: "error"; readonly message: string };

/**
 * Where this account's agents stand right now. Cheap and read-only, so a
 * surface that has to wait may poll it on a short interval.
 */
export async function fetchAgentReadiness(
  tenantId: string,
): Promise<AgentReadiness> {
  try {
    const response = await fetch(
      `/api/onboarding/provisioning-status?${new URLSearchParams({ tenantId })}`,
    );
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
    if (parsed instanceof type.errors)
      throw new Error("Invalid agent readiness response");
    if (parsed.kind === "ready") return { kind: "ready" };
    return parsed.setupAgentReady
      ? { kind: "chat-ready" }
      : { kind: "preparing" };
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
