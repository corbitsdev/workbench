import { describe, expect, test } from "bun:test";

import { createPendingDialogRequest } from "./pending-dialog-request";

describe("createPendingDialogRequest", () => {
  test("on-route dispatches immediately and never sets a pending flag", () => {
    const store = createPendingDialogRequest();
    let dispatched = 0;
    let navigated = 0;
    store.request({
      alreadyOnTargetRoute: true,
      navigateToTargetRoute: () => navigated++,
      dispatch: () => dispatched++,
    });
    expect(dispatched).toBe(1);
    expect(navigated).toBe(0);
    expect(store.consumePending()).toBe(false);
  });

  test("off-route navigates and records a pending flag instead of dispatching", () => {
    const store = createPendingDialogRequest();
    let dispatched = 0;
    let navigated = 0;
    store.request({
      alreadyOnTargetRoute: false,
      navigateToTargetRoute: () => navigated++,
      dispatch: () => dispatched++,
    });
    expect(dispatched).toBe(0);
    expect(navigated).toBe(1);
    expect(store.consumePending()).toBe(true);
  });

  test("consumePending clears the flag — a second read reports nothing pending", () => {
    const store = createPendingDialogRequest();
    store.request({
      alreadyOnTargetRoute: false,
      navigateToTargetRoute: () => undefined,
      dispatch: () => undefined,
    });
    expect(store.consumePending()).toBe(true);
    expect(store.consumePending()).toBe(false);
  });

  test("resetPending drops a pending flag without consuming it as true", () => {
    const store = createPendingDialogRequest();
    store.request({
      alreadyOnTargetRoute: false,
      navigateToTargetRoute: () => undefined,
      dispatch: () => undefined,
    });
    store.resetPending();
    expect(store.consumePending()).toBe(false);
  });

  test("two stores never share pending state", () => {
    const a = createPendingDialogRequest();
    const b = createPendingDialogRequest();
    a.request({
      alreadyOnTargetRoute: false,
      navigateToTargetRoute: () => undefined,
      dispatch: () => undefined,
    });
    expect(a.consumePending()).toBe(true);
    expect(b.consumePending()).toBe(false);
  });
});
