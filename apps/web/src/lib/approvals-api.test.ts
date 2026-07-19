/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  approveRequest,
  approveNativeRequest,
  listApprovals,
  listNativeApprovals,
  rejectRequest,
  rejectNativeRequest,
  type Approval,
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

const VALID_ROW: Approval = {
  id: "apr-1",
  tenantId: "tenant-1",
  principalId: "prn-1",
  agentId: "agt-1",
  sessionId: null,
  resource: "tool:notion__create_page",
  action: "Run notion__create_page",
  context: { title: "demo" },
  status: "pending",
  message: null,
  createdAt: "2026-07-10T00:00:00.000Z",
  resolvedAt: null,
};

describe("listApprovals", () => {
  it("returns the parsed approvals for a well-formed response", async () => {
    stubFetch([VALID_ROW]);

    const approvals = await listApprovals("tenant-1");

    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.id).toBe("apr-1");
    expect(approvals[0]?.sessionId).toBeNull();
  });

  it("throws when a row is missing a required field", async () => {
    const { message: _omitted, ...missingMessage } = VALID_ROW;
    stubFetch([missingMessage]);

    await expect(listApprovals("tenant-1")).rejects.toThrow(
      "Invalid approvals response",
    );
  });

  it("throws when a row has an out-of-range status", async () => {
    stubFetch([{ ...VALID_ROW, status: "bogus" }]);

    await expect(listApprovals("tenant-1")).rejects.toThrow(
      "Invalid approvals response",
    );
  });
});

describe("hub v1 route targeting", () => {
  it("lists approvals from the /api/v1 route the hub serves", async () => {
    const capture = stubFetch([VALID_ROW]);

    await listApprovals("tenant-1");

    expect(new URL(capture.url()).pathname).toBe(
      "/api/v1/tenants/tenant-1/approvals",
    );
  });

  it("approves via the /api/v1 route", async () => {
    const capture = stubFetch(VALID_ROW);

    await approveRequest("tenant-1", "apr-1");

    expect(new URL(capture.url()).pathname).toBe(
      "/api/v1/tenants/tenant-1/approvals/apr-1/approve",
    );
  });

  it("rejects via the /api/v1 route", async () => {
    const capture = stubFetch(VALID_ROW);

    await rejectRequest("tenant-1", "apr-1", "no thanks");

    expect(new URL(capture.url()).pathname).toBe(
      "/api/v1/tenants/tenant-1/approvals/apr-1/reject",
    );
  });

  it("forwards the rejection message in the request body", async () => {
    const capture = stubFetch(VALID_ROW);

    await rejectRequest("tenant-1", "apr-1", "no thanks");

    const body = capture.init()?.body;
    expect(typeof body).toBe("string");
    expect(JSON.parse(body as string)).toEqual({ message: "no thanks" });
  });

  it("sends no body when rejecting without a message", async () => {
    const capture = stubFetch(VALID_ROW);

    await rejectRequest("tenant-1", "apr-1");

    expect(capture.init()?.body).toBeUndefined();
  });
});

describe("approveRequest", () => {
  it("throws when the single-approval response is malformed", async () => {
    stubFetch({ ...VALID_ROW, sessionId: 42 });

    await expect(approveRequest("tenant-1", "apr-1")).rejects.toThrow(
      "Invalid approval response",
    );
  });
});

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
});

describe("error surfacing", () => {
  it("surfaces a legible message when the error body nests { error: { message } }", async () => {
    stubFetch(
      { error: { code: "not_implemented", message: "Not implemented" } },
      501,
    );

    await expect(listApprovals("tenant-1")).rejects.toThrow("Not implemented");
  });

  it("never surfaces a raw object as the error message", async () => {
    stubFetch(
      { error: { code: "not_implemented", message: "Not implemented" } },
      501,
    );

    await expect(listApprovals("tenant-1")).rejects.not.toThrow(
      "[object Object]",
    );
  });

  it("surfaces a legible message from approveRequest on a nested error body", async () => {
    stubFetch({ error: { code: "forbidden", message: "Forbidden" } }, 403);

    await expect(approveRequest("tenant-1", "apr-1")).rejects.toThrow(
      "Forbidden",
    );
  });
});
