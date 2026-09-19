// A person's address is their auth user id, which is mixed case. Small models
// lowercase an address before replying, so the canonical form is lowercase
// everywhere a person's address is shown, stamped, or handed to an agent.

export function personMailAddress(refId: string, tenantDomain: string): string {
  return `${refId}@${tenantDomain}`.toLowerCase();
}
