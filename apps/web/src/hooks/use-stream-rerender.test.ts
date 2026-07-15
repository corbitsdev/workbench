/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useStreamRerender } from "./use-stream-rerender";

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function renderCounted() {
  let renders = 0;
  const hook = renderHook(() => {
    renders += 1;
    return useStreamRerender();
  });
  return { hook, renders: () => renders };
}

describe("useStreamRerender", () => {
  it("re-renders the component after a burst of calls", async () => {
    const { hook, renders } = renderCounted();
    const before = renders();

    await act(async () => {
      hook.result.current();
      await nextFrame();
    });

    expect(renders()).toBeGreaterThan(before);
  });

  it("coalesces many synchronous calls into a single re-render", async () => {
    const { hook, renders } = renderCounted();
    const before = renders();

    await act(async () => {
      for (let i = 0; i < 50; i += 1) hook.result.current();
      await nextFrame();
      await nextFrame();
    });

    expect(renders()).toBe(before + 1);
  });

  it("keeps re-rendering for calls in later frames", async () => {
    const { hook, renders } = renderCounted();
    const before = renders();

    await act(async () => {
      hook.result.current();
      await nextFrame();
    });
    await act(async () => {
      hook.result.current();
      await nextFrame();
    });

    expect(renders()).toBe(before + 2);
  });

  it("returns a stable callback across re-renders", async () => {
    const { hook } = renderCounted();
    const first = hook.result.current;

    await act(async () => {
      hook.result.current();
      await nextFrame();
    });

    expect(hook.result.current).toBe(first);
  });

  it("does not update state after unmount", async () => {
    const { hook, renders } = renderCounted();

    act(() => {
      hook.result.current();
    });
    hook.unmount();
    const after = renders();

    await act(async () => {
      await nextFrame();
      await nextFrame();
    });

    expect(renders()).toBe(after);
  });
});
