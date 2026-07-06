/**
 * True when a query error is an HTTP 403 (permission denied). The hub returns
 * 403 when the caller lacks the `activity:principal`/`read` grant for another
 * principal's activity; the client surfaces the status on its `HttpError`
 * (`@workbench/client`), which carries a numeric `status`. Duck-typed on that
 * field so the check holds for any error carrying an HTTP status.
 */
export function isPermissionDeniedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 403
  );
}
