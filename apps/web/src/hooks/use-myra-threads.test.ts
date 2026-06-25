/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  readLastActiveThreadId,
  resolveActiveThread,
  writeLastActiveThreadId,
} from "./use-myra-threads";
import type { MyraThread } from "../lib/hub-api";

const thread = (id: string): MyraThread => ({
  id,
  instanceId: `inst-${id}`,
  label: `Chat ${id}`,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const threads = [thread("a"), thread("b"), thread("c")];

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("last-active thread storage", () => {
  it("round-trips the last-active id", () => {
    expect(readLastActiveThreadId()).toBeNull();
    writeLastActiveThreadId("b");
    expect(readLastActiveThreadId()).toBe("b");
  });
});

describe("resolveActiveThread", () => {
  it("returns null when there are no threads", () => {
    expect(resolveActiveThread([])).toBeNull();
  });

  it("prefers an explicit id that exists", () => {
    writeLastActiveThreadId("c");
    expect(resolveActiveThread(threads, "b")?.id).toBe("b");
  });

  it("falls back to the stored last-active id when explicit id is absent or unknown", () => {
    writeLastActiveThreadId("c");
    expect(resolveActiveThread(threads, "does-not-exist")?.id).toBe("c");
    expect(resolveActiveThread(threads)?.id).toBe("c");
  });

  it("falls back to the first thread when nothing else matches", () => {
    writeLastActiveThreadId("gone");
    expect(resolveActiveThread(threads)?.id).toBe("a");
  });
});
