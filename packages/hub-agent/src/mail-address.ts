import { type } from "arktype";

export const UserMailAddressArgs = type({
  userRefId: "string > 0",
  domain: "string > 0",
});
export type UserMailAddressArgs = typeof UserMailAddressArgs.infer;

/**
 * Derive a human user's deliverable mail address from their principal's
 * `refId` (the `usr_`-prefixed auth user id) and the tenant's domain (the
 * value threaded to workflow deploy as `deploymentDomain`).
 *
 * Mirrors the production address shape interchange uses for user
 * recipients. NOT `deriveDeploymentAddress` (that helper hardcodes the
 * `ins_` agent prefix), and deliberately outside `parseAgentAddress`'s
 * vocabulary — agent-address parsers reject `usr_` by design.
 */
export function deriveUserMailAddress(args: UserMailAddressArgs): string {
  const parsed = UserMailAddressArgs.assert(args);
  return `${parsed.userRefId}@${parsed.domain}`;
}
