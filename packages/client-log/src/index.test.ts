import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  flushLogBuffer,
  getLogger,
  peekLogBuffer,
  resetClientLogForTests,
  setConsoleThreshold,
} from "./index";

describe("client log", () => {
  beforeEach(() => resetClientLogForTests());
  afterEach(() => resetClientLogForTests());

  test("records category, level, message, and data", () => {
    const log = getLogger("onboarding.provision");
    log.error("provisioning failed", { userId: "user_1" });

    const entries = peekLogBuffer();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.category).toBe("onboarding.provision");
    expect(entries[0]?.level).toBe("error");
    expect(entries[0]?.message).toBe("provisioning failed");
    expect(entries[0]?.data).toEqual({ userId: "user_1" });
  });

  test("flushLogBuffer returns and clears; peekLogBuffer only reads", () => {
    const log = getLogger("test");
    log.info("one");
    log.info("two");

    expect(peekLogBuffer()).toHaveLength(2);
    expect(peekLogBuffer()).toHaveLength(2);

    const flushed = flushLogBuffer();
    expect(flushed).toHaveLength(2);
    expect(peekLogBuffer()).toHaveLength(0);
  });

  test("the ring buffer caps at 500 entries, dropping the oldest", () => {
    const log = getLogger("test");
    for (let i = 0; i < 510; i += 1) log.info(`entry ${i}`);

    const entries = peekLogBuffer();
    expect(entries).toHaveLength(500);
    expect(entries[0]?.message).toBe("entry 10");
    expect(entries[entries.length - 1]?.message).toBe("entry 509");
  });

  test("console mirroring respects the configured threshold", () => {
    const calls: { level: string; args: unknown[] }[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = (...args: unknown[]) => calls.push({ level: "log", args });
    console.warn = (...args: unknown[]) => calls.push({ level: "warn", args });
    console.error = (...args: unknown[]) =>
      calls.push({ level: "error", args });

    try {
      const log = getLogger("test");
      log.debug("quiet by default");
      expect(calls).toHaveLength(0);

      log.warn("mirrors by default");
      expect(calls).toHaveLength(1);

      setConsoleThreshold("debug");
      log.debug("now mirrors too");
      expect(calls).toHaveLength(2);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }
  });
});
