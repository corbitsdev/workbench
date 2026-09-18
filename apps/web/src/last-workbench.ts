// Recorded per bench and read back once on mount, never a live
// subscription, so a workbench visited after Files is open doesn't
// yank the lens out from under the user.

const KEY_PREFIX = "workbench.lastWorkbenchId.";

export function recordLastWorkbenchId(benchTenantId: string, workbenchId: string): void {
  try {
    window.sessionStorage.setItem(`${KEY_PREFIX}${benchTenantId}`, workbenchId);
  } catch {
    // A private-browsing tab with storage disabled loses this signal —
    // Files just defaults to "All workbenches" instead of misbehaving.
  }
}

export function readLastWorkbenchId(benchTenantId: string): string | null {
  try {
    return window.sessionStorage.getItem(`${KEY_PREFIX}${benchTenantId}`);
  } catch {
    return null;
  }
}
