// The pure evaluation core: no DB, no HTTP, no env access. Every
// decision this package makes — can this email self-sign-up, can this
// role create a sub-workbench — reduces to one of the functions below,
// called with plain data. Everything else in the package (store.ts,
// gate.ts, routes.ts) is composition around this file.
import { type } from "arktype";

import {
  AccessPolicy,
  DEFAULT_ACCESS_POLICY,
  type PolicyRowShape,
} from "./types";

/** Parses the `allowed_domains` column's JSON text. A malformed value
 * (should never happen — the column is only ever written by this
 * package) is treated as empty rather than thrown, so a corrupt row
 * fails closed on domain matching instead of crashing the request. */
export function parseAllowedDomainsColumn(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const result = type("string[]")(parsed);
  return result instanceof type.errors ? [] : result;
}

export function serializeAllowedDomains(domains: readonly string[]): string {
  return JSON.stringify(domains);
}

/** Absent row = closed defaults: signup off, owners-only sub-workbench
 * creation. This is the one place that default is expressed. */
export function resolveAccessPolicy(
  row: PolicyRowShape | undefined,
): AccessPolicy {
  if (row === undefined) return DEFAULT_ACCESS_POLICY;
  return {
    selfSignup: row.selfSignup,
    allowedDomains: parseAllowedDomainsColumn(row.allowedDomains),
    tenancyCreation: row.tenancyCreation,
  };
}

/** The lowercased domain half of an email, or undefined for anything
 * that isn't shaped like `local@domain`. */
export function domainOf(email: string): string | undefined {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return undefined;
  const domain = trimmed.slice(at + 1);
  return domain.length > 0 ? domain : undefined;
}

/** An empty allowlist means "any domain". */
export function domainAllowed(
  domain: string,
  allowedDomains: readonly string[],
): boolean {
  if (allowedDomains.length === 0) return true;
  const needle = domain.toLowerCase();
  return allowedDomains.some((d) => d.toLowerCase() === needle);
}

export type SignupGateReason =
  | "invalid_email"
  | "email_unverified"
  | "signup_closed"
  | "domain_not_allowed"
  | "policy_open"
  | "policy_domain_match";

export type SignupGateResult = {
  readonly allowed: boolean;
  readonly reason: SignupGateReason;
};

export type SignupGateArgs = {
  /** The tenant's own policy row, resolved through `resolveAccessPolicy`
   * — pass `undefined` only when no row exists at all, in which case
   * the closed defaults apply. */
  readonly policy: AccessPolicy | undefined;
  readonly email: string;
  /** better-auth is configured without `requireEmailVerification`, so
   * an unverified address can claim any domain. Every email-trust
   * decision this gate makes requires `emailVerified` unless
   * `allowUnverifiedEmails` opts out (dev/test only). Checked before
   * the policy is ever consulted, so no policy can allow an
   * unverified email through. */
  readonly emailVerified: boolean;
  readonly allowUnverifiedEmails: boolean;
};

/**
 * The one signup-gate evaluation function. The tenant's policy row
 * decides outright; with no row yet the closed defaults apply, so a
 * hub without an explicit open row never self-grants membership.
 */
export function evaluateSignupGate(args: SignupGateArgs): SignupGateResult {
  const domain = domainOf(args.email);
  if (domain === undefined) return { allowed: false, reason: "invalid_email" };

  if (!args.emailVerified && !args.allowUnverifiedEmails) {
    return { allowed: false, reason: "email_unverified" };
  }

  const policy = args.policy ?? DEFAULT_ACCESS_POLICY;
  if (policy.selfSignup === "off") {
    return { allowed: false, reason: "signup_closed" };
  }
  if (policy.selfSignup === "open") {
    return { allowed: true, reason: "policy_open" };
  }
  return domainAllowed(domain, policy.allowedDomains)
    ? { allowed: true, reason: "policy_domain_match" }
    : { allowed: false, reason: "domain_not_allowed" };
}

/**
 * Whether a principal holding these role names may create a
 * sub-workbench (a child tenant) under the tenant this policy governs.
 * `roleNames` are native role names ("owner", "admin", ...) — this
 * function has no opinion on how they were resolved.
 */
export function canCreateTenancy(
  policy: AccessPolicy,
  roleNames: readonly string[],
): boolean {
  const names = new Set(roleNames.map((n) => n.toLowerCase()));
  switch (policy.tenancyCreation) {
    case "owners":
      return names.has("owner");
    case "owners-admins":
      return names.has("owner") || names.has("admin");
    case "none":
      return false;
  }
}
