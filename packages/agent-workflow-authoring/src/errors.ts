export type WorkflowAuthorErrorReason =
  "forbidden" | "not_found" | "conflict" | "invalid";

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
