import { describe, it, expect } from "bun:test";
import {
  buildDeployRequest,
  resolveDeployAuth,
  resolveWorkflowEntry,
} from "./deploy-workflow";

describe("resolveDeployAuth", () => {
  it("prefers SESSION_TOKEN (operator session path)", () => {
    const auth = resolveDeployAuth({
      SESSION_TOKEN: "sess",
      SIDECAR_TOKEN: "svc",
    } as NodeJS.ProcessEnv);
    expect(auth).toEqual({ mode: "session", sessionToken: "sess" });
  });

  it("falls back to SIDECAR_TOKEN when no session is present", () => {
    const auth = resolveDeployAuth({
      SIDECAR_TOKEN: "svc",
    } as NodeJS.ProcessEnv);
    expect(auth).toEqual({ mode: "service", serviceToken: "svc" });
  });

  it("accepts HUB_SERVICE_TOKEN as a legacy alias for the service token", () => {
    const auth = resolveDeployAuth({
      HUB_SERVICE_TOKEN: "legacy",
    } as NodeJS.ProcessEnv);
    expect(auth).toEqual({ mode: "service", serviceToken: "legacy" });
  });

  it("throws when no credential is available", () => {
    expect(() => resolveDeployAuth({} as NodeJS.ProcessEnv)).toThrow(
      /no credential found/,
    );
  });
});

describe("resolveWorkflowEntry", () => {
  it("resolves a real workflow kind to its on-disk entry file", () => {
    const entry = resolveWorkflowEntry("pain-point-collateral");
    expect(entry).toMatch(/workflows\/pain-point-collateral\/src\/index\.ts$/);
  });

  it("throws for a kind with no workflow package", () => {
    expect(() => resolveWorkflowEntry("does-not-exist")).toThrow(
      /no workflow package at workflows\/does-not-exist/,
    );
  });
});

describe("buildDeployRequest", () => {
  it("session auth posts to /api/v1 with the better-auth cookie", () => {
    const { url, headers } = buildDeployRequest("http://hub", "?tenant=gtm", {
      mode: "session",
      sessionToken: "sess",
    });
    expect(url).toBe("http://hub/api/v1/workflows/deploy?tenant=gtm");
    expect(headers["Cookie"]).toContain("better-auth.session_token=sess");
    expect(headers["Cookie"]).toContain(
      "__Secure-better-auth.session_token=sess",
    );
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("service auth posts to /api/internal with a Bearer token", () => {
    const { url, headers } = buildDeployRequest("http://hub", "", {
      mode: "service",
      serviceToken: "svc",
    });
    expect(url).toBe("http://hub/api/internal/workflows/deploy");
    expect(headers["Authorization"]).toBe("Bearer svc");
    expect(headers["Cookie"]).toBeUndefined();
  });
});
