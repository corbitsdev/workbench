// Observing `@corbits/react-ui`'s `toast` from a test means `mock.module`,
// which rewrites the module registry for the whole process rather than for
// the calling file — and bun offers no way to take that back. A stub
// installed by one test file is therefore still installed when every later
// file loads, and `toast-single-system.test.tsx` renders the real toaster
// and asserts on the DOM: under a plain stub it observes nothing and fails
// for reasons that have nothing to do with toasts.
//
// So the spy DELEGATES rather than replaces. Callers get the call record
// they assert on, and any file that renders a real `<Toaster />` still sees
// real toasts, whichever order bun happens to load the suites in.

import { mock } from "bun:test";
import { toast as sonnerToast } from "sonner";

const actualReactUi = await import("@corbits/react-ui");
const realToast = actualReactUi.toast;

type ToastFn = typeof actualReactUi.toast;

/**
 * Installs a delegating spy over `toast` and returns it. Call once at module
 * scope; `mockClear()` it between tests the way any other spy is cleared.
 */
export function spyOnReactUiToast(): ReturnType<typeof mock<ToastFn>> {
  const spy = mock(((...args: Parameters<ToastFn>) =>
    realToast(...args)) as ToastFn);
  // `toast` carries its own variants (`toast.error` and friends); the spy
  // stands in for the whole callable, so it must carry them too.
  Object.assign(spy, realToast);
  mock.module("@corbits/react-ui", () => ({
    ...actualReactUi,
    toast: spy,
  }));
  return spy;
}

/**
 * Empties sonner's toast store. The store is global and outlives any one
 * `<Toaster />` mount or test file, so a suite that counts rendered toasts
 * starts here. `@corbits/react-ui`'s `toast` is a raise-only wrapper with no
 * dismiss of its own, so the clear goes to sonner directly.
 */
export function clearToasts(): void {
  sonnerToast.dismiss();
}
