// Delegates rather than replaces `toast` — see docs/test-toast-mock.md for
// why a plain stub breaks other suites via bun's global module registry.

import { mock } from "bun:test";
import { toast as sonnerToast } from "sonner";

const actualReactUi = await import("@corbits/react-ui");
const realToast = actualReactUi.toast;

type ToastFn = typeof actualReactUi.toast;

// Call once at module scope; `mockClear()` between tests like any spy.
export function spyOnReactUiToast(): ReturnType<typeof mock<ToastFn>> {
  const spy = mock(((...args: Parameters<ToastFn>) => realToast(...args)) as ToastFn);
  // `toast` carries its own variants (`toast.error` and friends); the spy
  // stands in for the whole callable, so it must carry them too.
  Object.assign(spy, realToast);
  mock.module("@corbits/react-ui", () => ({
    ...actualReactUi,
    toast: spy,
  }));
  return spy;
}

// Sonner's store is global and outlives any one test file; `toast` is a
// raise-only wrapper with no dismiss of its own, so this clears sonner directly.
export function clearToasts(): void {
  sonnerToast.dismiss();
}
