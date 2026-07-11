/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  approveRequest,
  listApprovals,
  rejectRequest,
  type Approval,
} from "./approvals-api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function stubFetch(body: unknown, status = 200): void {
  globalThis.fetch = mock(async () =>
    jsonResponse(body, status),
  ) as unknown as typeof fetch;
}

function captureUrl(body: unknown): { url: () => string } {
  let captured = "";
  globalThis.fetch = mock(async (input: URL | RequestInfo) => {
    captured = typeof input === "string" ? input : input.toString();
    return jsonResponse(body);
  }) as unknown as typeof fetch;
  return { url: () => captured };
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
    const capture = captureUrl([VALID_ROW]);

    await listApprovals("tenant-1");

    expect(new URL(capture.url()).pathname).toBe(
      "/api/v1/tenants/tenant-1/approvals",
    );
  });

  it("approves via the /api/v1 route", async () => {
    const capture = captureUrl(VALID_ROW);

    await approveRequest("tenant-1", "apr-1");

    expect(new URL(capture.url()).pathname).toBe(
      "/api/v1/tenants/tenant-1/approvals/apr-1/approve",
    );
  });

  it("rejects via the /api/v1 route", async () => {
    const capture = captureUrl(VALID_ROW);

    await rejectRequest("tenant-1", "apr-1", "no thanks");

    expect(new URL(capture.url()).pathname).toBe(
      "/api/v1/tenants/tenant-1/approvals/apr-1/reject",
    );
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
