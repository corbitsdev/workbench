// The approval mutations this app's approvals page now drives: approve is
// always scope "once" (the hub 400s on "always" — see
// vendor/intx/hub-api/src/routes/approvals.ts), and reject carries an
// optional message. Stub global fetch and assert both the request made and
// how the response is parsed, the same convention the settings-ui and
// bench-ui API clients are tested with.

import { afterEach, describe, expect, test } from "bun:test";

import { APIMutationError, approveApproval, rejectApproval } from "../src/api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type RecordedCall = { readonly path: string; readonly init?: RequestInit };

function stubFetch(respond: (path: string) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    calls.push(init === undefined ? { path } : { path, init });
    return Promise.resolve(respond(path));
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const approvalFixture = {
  id: "apr_1",
  tenantId: "tnt_1",
  anchorRunId: "run_anchor1",
  runId: "run_1",
  agentAddress: "agent://tnt_1/billing-bot",
  correlationId: "corr_1",
  toolDefinition: { name: "send_email" },
  toolArguments: { to: "person@example.com" },
  scope: "once",
  status: "approved",
  timeoutAt: null,
  resolvedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("approveApproval", () => {
  test("always sends scope 'once'", async () => {
    const calls = stubFetch(() => json(approvalFixture));
    await approveApproval("tnt_1", "apr_1");
    expect(calls[0]?.path).toBe("/api/tenants/tnt_1/approvals/apr_1/approve");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      scope: "once",
    });
  });

  test("throws an APIMutationError on a non-2xx response", async () => {
    stubFetch(() => json({ error: { code: "already_resolved" } }, 409));
    await expect(approveApproval("tnt_1", "apr_1")).rejects.toBeInstanceOf(
      APIMutationError,
    );
  });
});

describe("rejectApproval", () => {
  test("omits the message body when none is given", async () => {
    const calls = stubFetch(() =>
      json({ ...approvalFixture, status: "rejected" }),
    );
    await rejectApproval("tnt_1", "apr_1");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({});
  });

  test("sends the message when given", async () => {
    const calls = stubFetch(() =>
      json({ ...approvalFixture, status: "rejected" }),
    );
    await rejectApproval("tnt_1", "apr_1", "Not now");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      message: "Not now",
    });
  });
});
