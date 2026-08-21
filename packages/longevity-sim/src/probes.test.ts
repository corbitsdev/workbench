import { describe, expect, test } from "bun:test";

import { countLogSignatures, parseRssKb } from "./probes";

describe("parseRssKb", () => {
  test("parses a plain ps -o rss= reading into bytes", () => {
    expect(parseRssKb("12345\n")).toBe(12345 * 1024);
  });

  test("trims surrounding whitespace", () => {
    expect(parseRssKb("   4096  \n")).toBe(4096 * 1024);
  });

  test("returns 0 for blank output", () => {
    expect(parseRssKb("")).toBe(0);
    expect(parseRssKb("   \n")).toBe(0);
  });

  test("returns 0 for unparseable output", () => {
    expect(parseRssKb("not-a-number")).toBe(0);
  });
});

describe("countLogSignatures", () => {
  test("counts every collector-failure signature", () => {
    const log = [
      "info: boot ok",
      "error: Failed to persist event id=1",
      "error: turn_part insert failed id=2",
      "error: Failed to persist event id=3",
    ].join("\n");
    const counts = countLogSignatures(log);
    expect(counts.collectorFailures).toBe(3);
    expect(counts.fanoutFailures).toBe(0);
    expect(counts.deadLetters).toBe(0);
    expect(counts.schedulerFailures).toBe(0);
  });

  test("counts fan-out failures and dead-letters independently", () => {
    const log = [
      "error: Routing failed for workbench wb_1",
      "warn: message dead-lettered after 5 retries",
      "error: Routing failed for workbench wb_2",
    ].join("\n");
    const counts = countLogSignatures(log);
    expect(counts.fanoutFailures).toBe(2);
    expect(counts.deadLetters).toBe(1);
  });

  test("counts a scheduler fire line only when it reads as a failure", () => {
    const log = [
      "info: scheduled fire of routine rt_1 succeeded",
      "error: scheduled fire of routine rt_2 failed to launch",
      "warn: scheduled fire of routine rt_3 rejected: bad definition",
    ].join("\n");
    const counts = countLogSignatures(log);
    expect(counts.schedulerFailures).toBe(2);
  });

  test("returns all-zero counts for a clean log", () => {
    const log = "info: everything is fine\ninfo: still fine\n";
    expect(countLogSignatures(log)).toEqual({
      collectorFailures: 0,
      fanoutFailures: 0,
      deadLetters: 0,
      schedulerFailures: 0,
    });
  });
});
