// Pure helpers still needed by the tenancy-kind discriminator. Display-
// name and slug helpers left with the deleted switcher / member list.

/** Every platform id prefix this UI must never render verbatim. Mirrors the
 * same floor `packages/chat-ui` enforces over its own fixture surface. */
const RAW_ID_PATTERN = /\b(prn_|ins_|tnt_|role_|grant_)[a-z0-9]/i;

/** True when `name` is (or contains) a raw platform id rather than a
 * human-assigned one — the shape a tenant falls back to server-side when
 * nothing ever named it. */
export function isRawIdentifier(name: string): boolean {
  return RAW_ID_PATTERN.test(name);
}
