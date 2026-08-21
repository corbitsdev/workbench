// Mints the same short, quotable, grep-able shape `@workbench/hub-client`'s
// `generateRefId` does, without depending on that package: hub-client
// pulls in the full workflow-catalog and inference stack, which this
// package's browser callers (and its own server-side ones) have no
// reason to carry just to mint an id.
export function generateRefId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${random}`;
}
