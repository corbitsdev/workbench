// The sole implementation of the short, quotable, grep-able refId shape
// (CL-7253). `@workbench/hub-client` re-exports this rather than keeping
// its own copy; this package stays free of `@workbench/hub-client`'s
// workflow-catalog and inference stack, which this package's browser
// callers (and its own server-side ones) have no reason to carry just to
// mint an id.
export function generateRefId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${random}`;
}
