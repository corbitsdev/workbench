import { describe, expect, mock, test } from "bun:test";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

function restorePlatform(): void {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  });
}

describe("readChildRssBytes", () => {
  test("reports resident bytes from a well-formed /proc/<pid>/statm on Linux", async () => {
    setPlatform("linux");
    mock.module("node:fs", () => ({
      readFileSync: () => "12345 2048 100 1 0 900 0\n",
    }));
    const { readChildRssBytes } = await import("./workflow-child-rss");

    expect(readChildRssBytes(4321)).toBe(2048 * 4096);
    restorePlatform();
  });

  test("returns undefined when statm content is malformed", async () => {
    setPlatform("linux");
    mock.module("node:fs", () => ({
      readFileSync: () => "not-a-number\n",
    }));
    const { readChildRssBytes } = await import("./workflow-child-rss");

    expect(readChildRssBytes(4321)).toBeUndefined();
    restorePlatform();
  });

  test("returns undefined when statm reports zero resident pages", async () => {
    setPlatform("linux");
    mock.module("node:fs", () => ({
      readFileSync: () => "12345 0 100 1 0 900 0\n",
    }));
    const { readChildRssBytes } = await import("./workflow-child-rss");

    expect(readChildRssBytes(4321)).toBeUndefined();
    restorePlatform();
  });

  test("returns undefined when the pid's statm file is missing (process exited)", async () => {
    setPlatform("linux");
    mock.module("node:fs", () => ({
      readFileSync: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    }));
    const { readChildRssBytes } = await import("./workflow-child-rss");

    expect(readChildRssBytes(4321)).toBeUndefined();
    restorePlatform();
  });

  test("returns undefined on a non-Linux platform without reading /proc at all", async () => {
    setPlatform("darwin");
    const readFileSync = mock(() => {
      throw new Error("should not be called on non-Linux platforms");
    });
    mock.module("node:fs", () => ({ readFileSync }));
    const { readChildRssBytes } = await import("./workflow-child-rss");

    expect(readChildRssBytes(4321)).toBeUndefined();
    expect(readFileSync).not.toHaveBeenCalled();
    restorePlatform();
  });

  test("returns undefined for a non-positive pid", async () => {
    setPlatform("linux");
    const { readChildRssBytes } = await import("./workflow-child-rss");

    expect(readChildRssBytes(0)).toBeUndefined();
    expect(readChildRssBytes(-1)).toBeUndefined();
    restorePlatform();
  });
});
