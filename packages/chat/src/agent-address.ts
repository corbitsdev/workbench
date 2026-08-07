// Agent-address helpers shared by this package's own fan-out
// (`routes.ts`) and by `@corbits/chat-ui`'s composer: splitting an
// address into its local part and domain. Mirrors the split
// `vendor/intx/types/src/agent-address.ts`'s `parseAgentAddress` does,
// but stays permissive about the left-hand side on purpose — the
// mention rule (see `mentions.ts`) only ever needs the substring before
// the first "@", never a validated `ins_`-prefixed instance id, so it
// tolerates any participant string rather than rejecting non-address
// ones the way `parseAgentAddress` does.

export function localPartOf(address: string): string {
  const at = address.indexOf("@");
  return at === -1 ? address : address.slice(0, at);
}

export function domainOf(address: string): string | undefined {
  const at = address.indexOf("@");
  return at === -1 ? undefined : address.slice(at + 1);
}
