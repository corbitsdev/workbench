// The short, quotable, grep-able refId shape — dependency-free so browser
// callers don't carry unrelated stacks just to mint an id.
export function generateRefId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${random}`;
}
