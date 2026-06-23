import { describe, it, expect } from "bun:test";
import { listCredentials, listProviders } from "./purge-credentials";

// Integration-style tests are omitted: the functions call the live hub API and
// require auth cookies. Behavior is covered by the admin/local.test.ts wiring
// tests and the seed-credentials integration path. This file documents the
// exported surface so future callers know what's available.

describe("purge-credentials exports", () => {
  it("exports listCredentials and listProviders", () => {
    expect(typeof listCredentials).toBe("function");
    expect(typeof listProviders).toBe("function");
  });
});
