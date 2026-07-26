/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installFakeTimers, type FakeTimers } from "./fake-timers";

describe("installFakeTimers", () => {
  let timers: FakeTimers;

  beforeEach(() => {
    timers = installFakeTimers();
  });
  afterEach(() => {
    timers.restore();
  });

  it("fires setTimeout after the delay", () => {
    let ran = false;
    setTimeout(() => {
      ran = true;
    }, 250);
    timers.advance(249);
    expect(ran).toBe(false);
    timers.advance(1);
    expect(ran).toBe(true);
  });

  it("fires setInterval on each period", () => {
    let count = 0;
    setInterval(() => {
      count += 1;
    }, 1000);
    timers.advance(2999);
    expect(count).toBe(2);
    timers.advance(1);
    expect(count).toBe(3);
  });
});
