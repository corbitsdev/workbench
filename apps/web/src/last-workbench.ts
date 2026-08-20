// Files' workbench-first lens (CL-6353) needs to know which workbench, if
// any, the user was just inside — a signal `/files` can't carry itself,
// since it's reached from the sidebar footer, not a workbench sub-route.
// Recorded per bench (a switch to a different bench must not default to a
// foreign bench's workbench) and read back once on mount — never a live
// subscription, so a workbench visited after Files is already open doesn't
// yank the lens out from under the user.

const KEY_PREFIX = "workbench.lastWorkbenchId.";

export function recordLastWorkbenchId(
  benchTenantId: string,
  workbenchId: string,
): void {
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
