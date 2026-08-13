// Real-timer wiring for `useTypingIndicator`, mounted against a DOM (see
// dom-setup.ts) rather than reasoned about via `nextTypingState` alone —
// the pure function is only "correct" if the effects around it actually
// arm, re-arm, reset on channel switch, and tear down a real timer.

import { describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { useTypingIndicator } from "../src/typing-indicator";
import type { TypingState } from "../src/typing-indicator";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Long enough that real event-loop jitter can't flip a "before expiry" /
// "after expiry" assertion; short enough to keep the suite well under a
// second even so.
const TEST_TIMEOUT_MS = 120;

function mount(
  selfPrincipalId: string | undefined,
  initialChannelId: string | null,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let latestState: TypingState = null;
  let send: (eventType: string, data: unknown) => void = () => {};
  let setChannelId: (id: string | null) => void = () => {};

  function Host() {
    const [channelId, updateChannelId] = useState(initialChannelId);
    setChannelId = updateChannelId;
    const { typingState, handleStreamEvent } = useTypingIndicator(
      selfPrincipalId,
      channelId,
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
    switchChannel: (id: string | null) =>
      act(() => {
        setChannelId(id);
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
    harness.ping("prn_other1"); // t=0, would expire at t=120 unless re-armed

    await harness.settle(50); // t=50
    harness.ping("prn_other1"); // re-armed: now expires at t=170

    // t=140 — past the original (unarmed) expiry at 120 with a 20ms
    // margin, but well before the re-armed one at 170. Still showing here
    // only makes sense if the re-arm actually took effect.
    await harness.settle(90);
    expect(harness.get()?.principalId).toBe("prn_other1");

    // t=210 — past the re-armed expiry at 170 with a 40ms margin.
    await harness.settle(70);
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

  test("switching channels clears whoever was typing in the one just left", () => {
    const harness = mount("prn_self1", "chan_a");
    harness.ping("prn_other1");
    expect(harness.get()?.principalId).toBe("prn_other1");

    harness.switchChannel("chan_b");
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
