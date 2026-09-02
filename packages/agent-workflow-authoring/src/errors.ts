export type WorkflowAuthorErrorReason =
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid"
  | "unavailable"
  // CL-7362: the native deploy re-probed and froze a definition whose wire
  // hash differs from the one the human approved via `expectedWireHash`.
  // Distinct from `conflict` (an `expectedHeadSha` race) so a caller can
  // tell the two apart without parsing the message.
  | "wire_hash_mismatch";

export class WorkflowAuthorError extends Error {
  readonly reason: WorkflowAuthorErrorReason;
  /** Set on a `conflict` raised by an `expectedHeadSha` mismatch: the sha
   * `refs/heads/main` actually points at, so the caller can re-read and
   * retry against it. */
  readonly currentHeadSha?: string;
  constructor(
    reason: WorkflowAuthorErrorReason,
    message: string,
    options: { readonly currentHeadSha?: string } = {},
  ) {
    super(message);
    this.name = "WorkflowAuthorError";
    this.reason = reason;
    if (options.currentHeadSha !== undefined) {
      this.currentHeadSha = options.currentHeadSha;
    }
  }
}
