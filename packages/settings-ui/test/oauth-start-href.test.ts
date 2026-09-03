// Pins the exact start URL every connect surface renders (CL-6394): the
// tenant-scoped `connections/oauth` mount, never onboarding's own
// first-login mount — targeting the latter is what crashed the hosted
// GitHub one-click connect. `@corbits/connections`' own
// github-oauth-connect suite drives this same literal end to end, so a
// change here that isn't mirrored there fails one side or the other.
import { describe, expect, test } from "bun:test";
import { oauthStartHref } from "../src/connections-section";

describe("oauthStartHref", () => {
  test("targets the tenant-scoped connections/oauth mount", () => {
    expect(oauthStartHref("tnt_1", "github", "/plugins")).toBe(
      "/api/tenants/tnt_1/connections/oauth/github/start?return=%2Fplugins",
    );
  });

  test("defaults the return path to the settings Connections page", () => {
    expect(oauthStartHref("tnt_1", "openrouter")).toBe(
      "/api/tenants/tnt_1/connections/oauth/openrouter/start?return=%2Fsettings%2Fconnections",
    );
  });

  test("never targets the onboarding mount", () => {
    expect(oauthStartHref("tnt_1", "huggingface")).not.toContain(
      "/api/onboarding/",
    );
  });
});
