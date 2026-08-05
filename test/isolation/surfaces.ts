// The registry of tenant-scoped surfaces the isolation sweep covers.
// Every entry is exercised three ways by the suite: a member request
// (which must reach the handler), a cross-tenant request (which must
// be refused with the platform's forbidden envelope and leak nothing),
// and an anonymous request (which must be refused outright).
//
// Adding a new extension to the sweep is two small edits, both in this
// suite's directory:
//   1. Register its route surface here — one entry per mounted route
//      worth sweeping.
//   2. Add one describe block to isolation.test.ts for any behavior
//      specific to that extension (see the echo block there for the
//      pattern).
// No other file changes; the generic sweep picks the entry up
// automatically.

export type TenantSurface = {
  /** Stable name used in test output. */
  name: string;
  method: "GET" | "POST";
  /** Builds the route path for a given tenant id. */
  path: (tenantId: string) => string;
  /** Request body for POST surfaces. */
  body?: string;
  contentType?: string;
  /**
   * Status a tenant member is expected to see on their own tenant.
   * This is the control that keeps the cross-tenant refusals honest:
   * the same request shape demonstrably reaches the handler for a
   * member, so a refusal for a non-member is the tenant gate working,
   * not a dead route.
   */
  memberStatus: number;
};

export const tenantSurfaces: TenantSurface[] = [
  // Native platform surfaces.
  {
    name: "principals list",
    method: "GET",
    path: (t) => `/api/tenants/${t}/principals`,
    memberStatus: 200,
  },
  {
    name: "credentials list",
    method: "GET",
    path: (t) => `/api/tenants/${t}/credentials`,
    memberStatus: 200,
  },
  {
    name: "grants list",
    method: "GET",
    path: (t) => `/api/tenants/${t}/grants`,
    memberStatus: 200,
  },
  {
    name: "workflow deployments list",
    method: "GET",
    path: (t) => `/api/tenants/${t}/workflows/instances`,
    memberStatus: 200,
  },
  {
    // No deployment is seeded, so a member sees the route's own
    // not-found; a non-member must still be stopped at the tenant
    // gate before the deployment id is ever looked at.
    name: "workflow runs list",
    method: "GET",
    path: (t) => `/api/tenants/${t}/workflows/wfd_isolation_probe/runs`,
    memberStatus: 404,
  },
  // Extension surfaces. One entry per extension route the hub mounts.
  {
    name: "echo extension",
    method: "POST",
    path: (t) => `/api/tenants/${t}/echo`,
    body: "isolation-ping",
    contentType: "text/plain",
    memberStatus: 200,
  },
];
