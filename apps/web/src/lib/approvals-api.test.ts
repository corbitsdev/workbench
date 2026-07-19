/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { type } from "arktype";
import {
  ApprovalEventSchema,
  approveNativeRequest,
  listNativeApprovals,
  rejectNativeRequest,
  type NativeApproval,
} from "./approvals-api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

// Single fetch stub that both returns a canned body and records the request, so
// tests can assert the outgoing URL and body without a second parallel helper.
function stubFetch(
  body: unknown,
  status = 200,
): { url: () => string; init: () => RequestInit | undefined } {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = mock(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedInit = init;
      return jsonResponse(body, status);
    },
  ) as unknown as typeof fetch;
  return { url: () => capturedUrl, init: () => capturedInit };
}

const VALID_NATIVE_ROW: NativeApproval = {
  id: "apr-native-1",
  tenantId: "tenant-1",
  deploymentId: "dep-1",
  runId: "run-1",
  agentAddress: "ins_dep-1@agents.example.com",
  correlationId: "corr-1",
  toolDefinition: null,
  toolArguments: null,
  scope: null,
  status: "pending",
  timeoutAt: null,
  resolvedAt: null,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

describe("native rail route targeting", () => {
  it("lists native approvals from the un-versioned /api/tenants route", async () => {
    const capture = stubFetch([VALID_NATIVE_ROW]);

    const rows = await listNativeApprovals("tenant-1");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("apr-native-1");
    expect(new URL(capture.url()).pathname).toBe(
      "/api/tenants/tenant-1/native-approvals",
    );
  });

  it("approves via Interchange's un-versioned route with scope once", async () => {
    const capture = stubFetch(VALID_NATIVE_ROW);

    await approveNativeRequest("tenant-1", "apr-native-1");

    expect(new URL(capture.url()).pathname).toBe(
      "/api/tenants/tenant-1/approvals/apr-native-1/approve",
    );
    expect(JSON.parse(capture.init()?.body as string)).toEqual({
      scope: "once",
    });
  });

  it("rejects via Interchange's un-versioned route, forwarding the message", async () => {
    const capture = stubFetch(VALID_NATIVE_ROW);

    await rejectNativeRequest("tenant-1", "apr-native-1", "no");

    expect(new URL(capture.url()).pathname).toBe(
      "/api/tenants/tenant-1/approvals/apr-native-1/reject",
    );
    expect(JSON.parse(capture.init()?.body as string)).toEqual({
      message: "no",
    });
  });

  it("throws when a native row is malformed", async () => {
    stubFetch([{ ...VALID_NATIVE_ROW, status: "bogus" }]);

    await expect(listNativeApprovals("tenant-1")).rejects.toThrow(
      "Invalid native approvals response",
    );
  });

  it("surfaces a legible message when the error body nests { error: { message } }", async () => {
    stubFetch(
      { error: { code: "not_implemented", message: "Not implemented" } },
      501,
    );

    await expect(listNativeApprovals("tenant-1")).rejects.toThrow(
      "Not implemented",
    );
  });
});

describe("ApprovalEventSchema", () => {
  it("accepts an 'updated' change notification so enrichment events refetch", () => {
    const parsed = ApprovalEventSchema({
      tenantId: "tenant-1",
      sessionId: null,
      kind: "updated",
    });
    expect(parsed instanceof type.errors).toBe(false);
  });

  it("rejects an unknown event kind", () => {
    const parsed = ApprovalEventSchema({
      tenantId: "tenant-1",
      sessionId: null,
      kind: "bogus",
    });
    expect(parsed instanceof type.errors).toBe(true);
  });
});
