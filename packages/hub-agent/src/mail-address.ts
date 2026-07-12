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

export type SplitMailAddress = { local: string; domain: string };

/**
 * Split a single mail address into its local and domain parts.
 *
 * Uses `lastIndexOf("@")`, not `indexOf`: local parts derived from a
 * principal `refId` are not guaranteed `@`-free (an imported/synced refId
 * can legitimately contain one), so splitting on the FIRST `@` would steal
 * characters from the local part into the domain. The domain itself is
 * never expected to contain `@`, so anchoring the split on the LAST `@` is
 * the only choice that recovers the intended domain in every case. Returns
 * `null` for an address with no `@`, or an empty local/domain part.
 */
export function splitMailAddress(address: string): SplitMailAddress | null {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return { local: address.slice(0, at), domain: address.slice(at + 1) };
}

/**
 * Split a comma-separated mail address-list header value (e.g. a `To`
 * header) into individual address entries, respecting RFC 5322
 * quoted-strings: a comma inside a double-quoted display name (e.g.
 * `"Doe, Jane" <a@b>`) does not end the entry. Not a full RFC 5322
 * parser — only quoted-string awareness, which is what the malformed
 * split needs.
 */
export function splitMailAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of value) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === "," && !inQuotes) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts.filter((part) => part.length > 0);
}
