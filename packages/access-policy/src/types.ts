// Trust-boundary shapes for the access policy this package owns.
// Anything that crosses a wire (a route body, a raw DB column, an env
// value) is parsed through one of these before the rest of the package
// touches it — never cast.
import { type } from "arktype";

export const SelfSignupMode = type("'off' | 'allowed-domains' | 'open'");
export type SelfSignupMode = typeof SelfSignupMode.infer;

export const TenancyCreationMode = type("'owners' | 'owners-admins' | 'none'");
export type TenancyCreationMode = typeof TenancyCreationMode.infer;

export const AllowedDomains = type("string[]");

export const AccessPolicy = type({
  selfSignup: SelfSignupMode,
  allowedDomains: AllowedDomains,
  tenancyCreation: TenancyCreationMode,
});
export type AccessPolicy = typeof AccessPolicy.infer;

/** Closed-by-default: an absent policy row is exactly this — signup
 * off, sub-workbench creation restricted to owners. */
export const DEFAULT_ACCESS_POLICY: AccessPolicy = {
  selfSignup: "off",
  allowedDomains: [],
  tenancyCreation: "owners",
};

export const UpdateAccessPolicy = type({
  "selfSignup?": SelfSignupMode,
  "allowedDomains?": AllowedDomains,
  "tenancyCreation?": TenancyCreationMode,
});
export type UpdateAccessPolicy = typeof UpdateAccessPolicy.infer;

/** A row as read out of `access_policy.policy`, with `allowedDomains`
 * still the raw JSON-text column — parsed via `parseAllowedDomainsColumn`
 * in ./policy.ts before it becomes an `AccessPolicy`. */
export type PolicyRowShape = {
  readonly tenantId: string;
  readonly selfSignup: SelfSignupMode;
  readonly allowedDomains: string;
  readonly tenancyCreation: TenancyCreationMode;
};

export const CreatePendingInvite = type({
  matchType: "'email' | 'domain'",
  value: "string > 0",
  "roleId?": "string > 0",
  "invitedBy?": "string > 0",
});
export type CreatePendingInvite = typeof CreatePendingInvite.infer;

export type PendingInvite = {
  readonly id: string;
  readonly tenantId: string;
  readonly matchType: "email" | "domain";
  readonly value: string;
  readonly roleId?: string;
  readonly invitedBy?: string;
  readonly createdAt: Date;
  readonly consumedAt?: Date;
};
