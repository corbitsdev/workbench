// The one shape every section's own fetch settles into: loading, failed, or
// ready with data. Shared here so each section's loading/error/ready
// rendering reads identically, the same floor bench-ui and chat-ui hold
// over their own local fetches.

export type LoadState<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly data: T };

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
