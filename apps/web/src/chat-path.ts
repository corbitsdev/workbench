// Shared react-query keys. A workbench is a child tenant, so its listing
// reads under the tenant scope beside the agent roster.

/** One key factory per workbench (a workbench child tenant), so a send
 * invalidates the workbench's timeline and roster together. */
export const workbenchKeys = {
  scope: (tenantId: string) => ["workbench", tenantId] as const,
  tenant: (tenantId: string) => ["workbench", tenantId, "tenant"] as const,
  participants: (tenantId: string) => ["workbench", tenantId, "participants"] as const,
  timeline: (tenantId: string) => ["workbench", tenantId, "timeline"] as const,
  /** The bench's own child tenants (its workbenches), read over the stock
   * tenant routes — previously `chatKeys.childTenants`, re-homed here when
   * standalone chats were removed. */
  childTenants: (tenantId: string) => ["tenant", tenantId, "child-tenants"] as const,
};
