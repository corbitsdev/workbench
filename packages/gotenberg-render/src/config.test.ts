import { describe, expect, test } from "bun:test";
import { resolveGotenbergConfig } from "./config";

describe("resolveGotenbergConfig", () => {
  test("returns null when GOTENBERG_URL is unset — the capability is absent", () => {
    expect(resolveGotenbergConfig({})).toBeNull();
  });

  test("returns null when GOTENBERG_URL is blank", () => {
    expect(resolveGotenbergConfig({ GOTENBERG_URL: "   " })).toBeNull();
  });

  test("resolves a configured URL, trimming a trailing slash", () => {
    expect(
      resolveGotenbergConfig({ GOTENBERG_URL: "http://gotenberg:3000/" }),
    ).toEqual({ baseUrl: "http://gotenberg:3000" });
  });

  test("throws on a value that isn't a URL", () => {
    expect(() => resolveGotenbergConfig({ GOTENBERG_URL: "not-a-url" })).toThrow();
  });
});
