// Real-timer wiring for `useTypingIndicator`, mounted against a DOM (see
// dom-setup.ts) rather than reasoned about via `nextTypingState` alone —
// the pure function is only "correct" if the effects around it actually
// arm, re-arm, reset on workbench switch, and tear down a real timer.

import { describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { useTypingIndicator } from "../src/typing-indicator";
import type { TypingState } from "../src/typing-indicator";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Long enough that real event-loop jitter can't flip a "before expiry" /
// "after expiry" assertion — CI runners under load have been observed to
// stretch a single await by well over 100ms, so every "before expiry"
// margin below is a quarter of the expiry or better. Short enough to keep
// the suite around two seconds even so.
const TEST_TIMEOUT_MS = 500;

function mount(
  selfPrincipalId: string | undefined,
  initialWorkbenchId: string | null,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let latestState: TypingState = null;
  let send: (eventType: string, data: unknown) => void = () => {};
  let setWorkbenchId: (id: string | null) => void = () => {};

  function Host() {
    const [workbenchId, updateWorkbenchId] = useState(initialWorkbenchId);
    setWorkbenchId = updateWorkbenchId;
    const { typingState, handleStreamEvent } = useTypingIndicator(
      selfPrincipalId,
      workbenchId,
      TEST_TIMEOUT_MS,
    );
    latestState = typingState;
    send = handleStreamEvent;
    return null;
  }

  act(() => {
    root.render(createElement(Host));
  });

  return {
    ping: (principalId: string) =>
      act(() => {
        send("chat.typing", { principalId });
      }),
    sendOther: (eventType: string) =>
      act(() => {
        send(eventType, {});
      }),
    switchWorkbench: (id: string | null) =>
      act(() => {
        setWorkbenchId(id);
      }),
    settle: (ms: number) => act(() => sleep(ms)),
    get: () => latestState,
    unmount: () => act(() => root.unmount()),
  };
}

describe("useTypingIndicator (real timer wiring)", () => {
  test("a solo typist's banner disappears after expiry with no further events", async () => {
    const harness = mount("prn_self1", "chan_a");
    harness.ping("prn_other1");
    expect(harness.get()?.principalId).toBe("prn_other1");

    await harness.settle(TEST_TIMEOUT_MS * 2);
    expect(harness.get()).toBeNull();
    harness.unmount();
  });

  test("a second ping re-arms the expiry rather than doubling timers", async () => {
    const harness = mount("prn_self1", "chan_a");
    harness.ping("prn_other1"); // t=0, would expire at t=500 unless re-armed

    await harness.settle(150); // t=150
    harness.ping("prn_other1"); // re-armed: now expires at t=650

    // t=400 — past the original (unarmed) expiry at 500 would be a
    // failure of the re-arm, and it is still 250ms before the re-armed
    // expiry at 650. Still showing here only makes sense if the re-arm
    // actually took effect.
    await harness.settle(250);
    expect(harness.get()?.principalId).toBe("prn_other1");

    // t=800 — past the re-armed expiry at 650 with a 150ms margin.
    await harness.settle(400);
    expect(harness.get()).toBeNull();
    harness.unmount();
  });

  test("unmounting clears the pending timer instead of letting it fire later", () => {
    const originalClearTimeout = globalThis.clearTimeout;
    let cleared = false;
    globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
      cleared = true;
      return originalClearTimeout(id);
    }) as typeof clearTimeout;

    try {
      const harness = mount("prn_self1", "chan_a");
      harness.ping("prn_other1");
      harness.unmount();
      expect(cleared).toBe(true);
    } finally {
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("switching workbenches clears whoever was typing in the one just left", () => {
    const harness = mount("prn_self1", "chan_a");
    harness.ping("prn_other1");
    expect(harness.get()?.principalId).toBe("prn_other1");

    harness.switchWorkbench("chan_b");
    expect(harness.get()).toBeNull();
    harness.unmount();
  });

  test("a non-typing event on the same stream never opens the banner", () => {
    const harness = mount("prn_self1", "chan_a");
    harness.sendOther("chat.agent");
    expect(harness.get()).toBeNull();
    harness.unmount();
  });
});
