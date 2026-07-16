/**
 * Pure path-mapping for the CL-3763 relocation of the standalone /admin and
 * /owner surfaces under /settings. Kept as pure functions (separate from the
 * `<Navigate>` wrapper components in router.tsx) so the sub-route mapping is
 * unit-testable without rendering a router.
 */
export function mapLegacyAdminPath(wildcardTail: string | undefined): string {
  return `/settings/admin${wildcardTail ? `/${wildcardTail}` : ""}`;
}

export function mapLegacyOwnerPath(wildcardTail: string | undefined): string {
  return `/settings/owner${wildcardTail ? `/${wildcardTail}` : ""}`;
}
