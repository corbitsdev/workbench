/// <reference types="bun" />
import "../test-setup";
import { describe, expect, it } from "bun:test";
import {
  ApiError,
  buildEventSourceUrl,
  isDeployInProgress,
  toApiError,
  withDeployRetry,
} from "./api";

function res(status: number, headers?: Record<string, string>): Response {
  return new Response(null, { status, headers });
}

describe("buildEventSourceUrl", () => {
  it("targets the same-origin /api/v1 proxy path, never a cross-origin hub base", () => {
    // A credentialed cross-origin EventSource is dropped by Safari ITP / Brave,
    // so the SSE URL must ride the same-origin /api/v1 proxy (Vite in dev, the
    // Vercel rewrite in prod) — window.location.origin — regardless of any
    // VITE_API_BASE_URL the normal fetch client may use.
    const url = buildEventSourceUrl(
      "/workflow-exec/runs/wfr_1/state/stream?tenantId=tn-x",
    );
    expect(url).toBe(
      "http://localhost/api/v1/workflow-exec/runs/wfr_1/state/stream?tenantId=tn-x",
    );
    expect(new URL(url).origin).toBe(window.location.origin);
  });

  it("normalizes a leading slash", () => {
    expect(buildEventSourceUrl("x/y")).toBe("http://localhost/api/v1/x/y");
  });
});

describe("toApiError", () => {
  it("uses the message from a flat { error: string } body (back-compat)", () => {
    const err = toApiError(res(400), { error: "no capacity" });
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("no capacity");
    expect(err.status).toBe(400);
    expect(err.code).toBeUndefined();
  });

  it("extracts message + code from a nested { error: { code, message } } body", () => {
    const err = toApiError(res(503), {
      error: { code: "deploy_in_progress", message: "Finishing an update." },
    });
    expect(err.message).toBe("Finishing an update.");
    expect(err.code).toBe("deploy_in_progress");
    expect(err.status).toBe(503);
  });

  it("reads retryAfterSeconds from the Retry-After header", () => {
    const err = toApiError(res(503, { "Retry-After": "10" }), {
      error: { code: "deploy_in_progress", message: "wait" },
    });
    expect(err.retryAfterSeconds).toBe(10);
  });

  it("falls back to a body retryAfterSeconds when no header is present", () => {
    const err = toApiError(res(503), {
      error: {
        code: "deploy_in_progress",
        message: "wait",
        retryAfterSeconds: 7,
      },
    });
    expect(err.retryAfterSeconds).toBe(7);
  });

  it("falls back to HTTP <status> when the body has no usable error", () => {
    const err = toApiError(res(500), null);
    expect(err.message).toBe("HTTP 500");
    expect(err.code).toBeUndefined();
  });
});

describe("isDeployInProgress", () => {
  it("is true only for a 503 with code deploy_in_progress", () => {
    expect(
      isDeployInProgress(new ApiError("x", 503, "deploy_in_progress")),
    ).toBe(true);
    expect(isDeployInProgress(new ApiError("x", 503, "other"))).toBe(false);
    expect(
      isDeployInProgress(new ApiError("x", 500, "deploy_in_progress")),
    ).toBe(false);
    expect(isDeployInProgress(new Error("nope"))).toBe(false);
  });
});

describe("withDeployRetry", () => {
  it("retries the deploy-window 503 and eventually returns the success", async () => {
    let calls = 0;
    let retryNotices = 0;
    const waits: number[] = [];
    const result = await withDeployRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new ApiError("wait", 503, "deploy_in_progress", 2);
        }
        return "ok";
      },
      {
        onRetrying: () => {
          retryNotices += 1;
        },
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(retryNotices).toBe(2);
    // Respected the Retry-After hint (2s) rather than the fallback.
    expect(waits).toEqual([2000, 2000]);
  });

  it("does not retry a non-deploy error and surfaces its message", async () => {
    let calls = 0;
    let retryNotices = 0;
    await expect(
      withDeployRetry(
        async () => {
          calls += 1;
          throw new ApiError("no capacity", 500);
        },
        { onRetrying: () => (retryNotices += 1), sleep: async () => undefined },
      ),
    ).rejects.toThrow("no capacity");
    expect(calls).toBe(1);
    expect(retryNotices).toBe(0);
  });

  it("gives up after the attempt cap and rejects with the last 503", async () => {
    let calls = 0;
    await expect(
      withDeployRetry(
        async () => {
          calls += 1;
          throw new ApiError("still deploying", 503, "deploy_in_progress");
        },
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow("still deploying");
    // Capped at 4 attempts.
    expect(calls).toBe(4);
  });
});
