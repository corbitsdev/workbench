import { describe, expect, test } from "bun:test";
import {
  renderSlackAppManifest,
  validateWorkbenchPublicOrigin,
} from "./manifest";

describe("validateWorkbenchPublicOrigin", () => {
  test("accepts a plain https origin", () => {
    expect(validateWorkbenchPublicOrigin("https://bench.example.com")).toBe(
      "https://bench.example.com",
    );
  });

  test("rejects http", () => {
    expect(() =>
      validateWorkbenchPublicOrigin("http://bench.example.com"),
    ).toThrow(/https/);
  });

  test("rejects a trailing slash", () => {
    expect(() =>
      validateWorkbenchPublicOrigin("https://bench.example.com/"),
    ).toThrow(/trailing slash|slash/);
  });

  test("rejects a path", () => {
    expect(() =>
      validateWorkbenchPublicOrigin("https://bench.example.com/slack"),
    ).toThrow(/no path/);
  });

  test("rejects an empty value", () => {
    expect(() => validateWorkbenchPublicOrigin("  ")).toThrow(/empty/);
  });
});

describe("renderSlackAppManifest", () => {
  test("substitutes the origin into both request URLs", () => {
    const rendered = renderSlackAppManifest("https://bench.example.com");
    expect(rendered).toContain(
      "https://bench.example.com/api/tag/slack/webhook",
    );
    expect(rendered).not.toContain("${WORKBENCH_PUBLIC_ORIGIN}");
  });

  test("declares the bot scopes and event subscriptions workbench needs", () => {
    const rendered = renderSlackAppManifest("https://bench.example.com");
    expect(rendered).toContain("app_mention");
    expect(rendered).toContain("chat:write");
  });
});
