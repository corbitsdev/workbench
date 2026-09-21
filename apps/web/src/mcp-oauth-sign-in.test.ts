// The Tools page's OAuth sign-in runs entirely through fetch: provider row,
// hub-held login, catalog read, metadata read-back and patch. The stub below
// stands in for the hub so each stage's requests and the rollback rules are pinned.

import { describe, expect, test } from "bun:test";

import { McpServerError, signInMcpServer } from "./mcp-servers";

type RecordedRequest = { method: string; url: string; body: unknown };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(
  handler: (request: RecordedRequest) => Response,
  recorded: RecordedRequest[],
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    let body: unknown;
    try {
      body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    } catch {
      body = undefined;
    }
    const request = { method: init?.method ?? "GET", url, body };
    recorded.push(request);
    return Promise.resolve(handler(request));
  }) as typeof fetch;
}

const TENANT = "/api/tenants/tnt_1";

function baseHandler(polls: unknown[]): (request: RecordedRequest) => Response {
  let pollCount = 0;
  return (request) => {
    const { method, url } = request;
    if (url === `${TENANT}/providers` && method === "GET") return jsonResponse({ data: [] });
    if (url === `${TENANT}/providers` && method === "POST") {
      return jsonResponse({ id: "prv_linear", name: "mcp-linear", plugin: "mcp-streamable-http" });
    }
    if (url === `${TENANT}/credentials` && method === "GET") return jsonResponse({ data: [] });
    if (url === `${TENANT}/mcp/oauth-logins` && method === "POST") {
      return jsonResponse({ loginId: "login-1", authorizeUrl: "https://auth.example/authorize" });
    }
    if (url === `${TENANT}/mcp/oauth-logins/login-1` && method === "GET") {
      const next = polls[Math.min(pollCount, polls.length - 1)];
      pollCount += 1;
      return jsonResponse(next);
    }
    if (url === `${TENANT}/mcp/discover` && method === "POST") {
      return jsonResponse({
        data: {
          serverInfo: {},
          tools: [{ name: "issue-create", inputSchema: {} }],
        },
      });
    }
    if (url.startsWith(`${TENANT}/credentials/`) && method === "PATCH") return jsonResponse({});
    if (url === `${TENANT}/credentials/crd_1` && method === "GET") {
      return jsonResponse({
        id: "crd_1",
        name: "mcp-linear",
        providerId: "prv_linear",
        metadata: {
          mcp: {
            handle: "linear",
            name: "Linear",
            url: "https://mcp.linear.app/mcp",
            auth: "oauth",
            tools: [],
          },
          mcpOAuthClientId: "dyn-client-1",
          mcpOAuthTokenUrl: "https://auth.example/token",
        },
      });
    }
    if (url.startsWith(`${TENANT}/credentials/`) && method === "DELETE") return jsonResponse({});
    if (url === `${TENANT}/mcp/oauth-logins/login-1` && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
}

const INPUT = {
  tenantId: "tnt_1",
  handle: "linear",
  name: "Linear",
  url: "https://mcp.linear.app/mcp",
  resourceUrl: "https://mcp.linear.app/mcp",
};

describe("signInMcpServer", () => {
  test("opens the authorize URL, waits for the login, then stores the catalog", async () => {
    const recorded: RecordedRequest[] = [];
    const fetchImpl = stubFetch(
      baseHandler([{ status: "pending" }, { status: "completed", credentialId: "crd_1" }]),
      recorded,
    );
    const opened: string[] = [];

    const server = await signInMcpServer(INPUT, fetchImpl, {
      openAuthorizeUrl: (url) => {
        opened.push(url);
      },
      sleep: () => Promise.resolve(),
      pollIntervalMs: 0,
    });

    expect(opened).toEqual(["https://auth.example/authorize"]);
    expect(server).toMatchObject({
      credentialId: "crd_1",
      providerId: "prv_linear",
      handle: "linear",
      auth: "oauth",
    });
    expect(server.tools.map((tool) => tool.name)).toEqual(["issue-create"]);

    const loginPost = recorded.find(
      (request) => request.url === `${TENANT}/mcp/oauth-logins` && request.method === "POST",
    );
    expect(loginPost?.body).toMatchObject({
      providerId: "prv_linear",
      handle: "linear",
      resourceUrl: "https://mcp.linear.app/mcp",
      credentialName: "mcp-linear",
    });
    const patch = recorded.find(
      (request) => request.url === `${TENANT}/credentials/crd_1` && request.method === "PATCH",
    );
    expect(patch?.body).toMatchObject({
      metadata: { mcp: { handle: "linear", auth: "oauth" } },
    });
  });

  test("OAuth sign-in preserves keys across PATCH", async () => {
    const recorded: RecordedRequest[] = [];
    const fetchImpl = stubFetch(
      baseHandler([{ status: "completed", credentialId: "crd_1" }]),
      recorded,
    );

    const server = await signInMcpServer(INPUT, fetchImpl, {
      openAuthorizeUrl: () => undefined,
      sleep: () => Promise.resolve(),
      pollIntervalMs: 0,
    });
    expect(server.auth).toBe("oauth");

    // The hub replaces metadata wholesale on PATCH, so the catalog write
    // must carry the stored OAuth refresh keys along — not just the `mcp`
    // map — or the next refresh has nothing to redeem.
    const patch = recorded.find(
      (request) => request.url === `${TENANT}/credentials/crd_1` && request.method === "PATCH",
    );
    const metadata = (patch?.body as { metadata?: Record<string, unknown> } | undefined)?.metadata;
    expect(metadata).toMatchObject({
      mcpOAuthClientId: "dyn-client-1",
      mcpOAuthTokenUrl: "https://auth.example/token",
      mcp: { handle: "linear", auth: "oauth" },
    });
    expect(
      (metadata?.["mcp"] as { tools?: { name?: unknown }[] } | undefined)?.tools?.map(
        (tool) => tool.name,
      ),
    ).toEqual(["issue-create"]);
  });

  test("a failed login surfaces the hub's message and withdraws the login", async () => {
    const recorded: RecordedRequest[] = [];
    const fetchImpl = stubFetch(
      baseHandler([{ status: "failed", message: "access denied" }]),
      recorded,
    );

    const cause: unknown = await signInMcpServer(INPUT, fetchImpl, {
      openAuthorizeUrl: () => undefined,
      sleep: () => Promise.resolve(),
      pollIntervalMs: 0,
    }).catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(McpServerError);
    expect(cause instanceof Error ? cause.message : "").toBe("access denied");
    expect(
      recorded.some(
        (request) =>
          request.url === `${TENANT}/mcp/oauth-logins/login-1` && request.method === "DELETE",
      ),
    ).toBe(true);
  });

  test("a first-time add that fails discovery rolls the credential back", async () => {
    const recorded: RecordedRequest[] = [];
    const fetchImpl = stubFetch((request) => {
      if (request.url === `${TENANT}/mcp/discover` && request.method === "POST") {
        return jsonResponse({ error: "unreachable" }, 502);
      }
      return baseHandler([{ status: "completed", credentialId: "crd_1" }])(request);
    }, recorded);

    await expect(
      signInMcpServer(INPUT, fetchImpl, {
        openAuthorizeUrl: () => undefined,
        sleep: () => Promise.resolve(),
        pollIntervalMs: 0,
      }),
    ).rejects.toBeInstanceOf(McpServerError);
    expect(
      recorded.some(
        (request) => request.url === `${TENANT}/credentials/crd_1` && request.method === "DELETE",
      ),
    ).toBe(true);
  });
});
