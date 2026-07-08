/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import {
  installFakeTimers,
  type FakeTimers,
} from "../test-support/fake-timers";
import { useDelayedFlag } from "./use-delayed-flag";

describe("useDelayedFlag", () => {
  let timers: FakeTimers;
  beforeEach(() => {
    timers = installFakeTimers();
  });
  afterEach(() => {
    timers.restore();
  });
  const advance = (ms: number) => act(() => timers.advance(ms));

  it("turns on only after active persists for the delay", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useDelayedFlag(active, 2500),
      { initialProps: { active: true } },
    );
    expect(result.current).toBe(false);
    advance(2499);
    expect(result.current).toBe(false);
    advance(1);
    expect(result.current).toBe(true);
    rerender({ active: true });
    expect(result.current).toBe(true);
  });

  it("never turns on if active clears before the delay elapses", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useDelayedFlag(active, 2500),
      { initialProps: { active: true } },
    );
    advance(1000);
    rerender({ active: false });
    expect(result.current).toBe(false);
    advance(5000);
    expect(result.current).toBe(false);
  });

  it("drops back to false immediately when active goes false", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useDelayedFlag(active, 1000),
      { initialProps: { active: true } },
    );
    advance(1000);
    expect(result.current).toBe(true);
    rerender({ active: false });
    expect(result.current).toBe(false);
  });
});
