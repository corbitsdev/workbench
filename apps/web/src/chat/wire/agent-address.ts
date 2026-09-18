// Mirrored from packages/chat/src (see docs/chat-wire-contract.md).

// Deliberately permissive, unlike `@intx/types`'s `parseAgentAddress`: the
// mention rule only needs the substring before "@", not a validated id.

export function localPartOf(address: string): string {
  const at = address.indexOf("@");
  return at === -1 ? address : address.slice(0, at);
}

export function domainOf(address: string): string | undefined {
  const at = address.indexOf("@");
  return at === -1 ? undefined : address.slice(at + 1);
}
