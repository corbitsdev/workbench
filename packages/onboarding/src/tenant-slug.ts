// The personal-bench slug this package's credential-completion path uses
// to recognize a bench it provisioned itself: a lowercase-kebab local part
// of the email plus a short fragment of the user's own id, unique per user
// without a coordinating registry. Signup no longer mints personal
// benches (CL-8085 moved 0→1 to the client's needs-list), but the
// credential step still needs this to find the right tenant.
export function personalTenantSlug(email: string, userId: string): string {
  const local = email.split("@")[0] ?? email;
  const kebab = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = userId
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-8)
    .toLowerCase();
  return `${kebab || "bench"}-${suffix || "personal"}`;
}
