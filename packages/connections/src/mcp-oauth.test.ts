import { describe, expect, spyOn, test } from "bun:test";
import * as errorSink from "@corbits/error-sink";
import { createMcpOAuthProvider, refreshMcpOAuthTokens } from "./mcp-oauth";

describe("createMcpOAuthProvider", () => {
  test("clientMetadata includes scope only when it is passed", () => {
    const session = { state: "oauth-state" };
    const withScope = createMcpOAuthProvider({
      callbackUrl: "http://hub.test/callback",
      clientName: "Corbits Workbench",
      session,
      scope: "profile:read asset:read",
    });
    expect(withScope.clientMetadata).toEqual({
      client_name: "Corbits Workbench",
      redirect_uris: ["http://hub.test/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "profile:read asset:read",
    });

    const withoutScope = createMcpOAuthProvider({
      callbackUrl: "http://hub.test/callback",
      clientName: "Corbits Workbench",
      session,
    });
    expect("scope" in withoutScope.clientMetadata).toBe(false);
    expect(withoutScope.clientMetadata).toEqual({
      client_name: "Corbits Workbench",
      redirect_uris: ["http://hub.test/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });
});

describe("refreshMcpOAuthTokens", () => {
  test("an unreachable server reports the failure and comes back ok: false", async () => {
    const report = spyOn(errorSink, "reportError").mockReturnValue("ref_test");
    const server = Bun.serve({ port: 0, fetch: () => new Response(null) });
    const serverUrl = `http://127.0.0.1:${String(server.port)}/mcp`;
    server.stop(true);

    const result = await refreshMcpOAuthTokens({
      serverUrl,
      tokens: { access_token: "at_1", token_type: "Bearer" },
      callbackUrl: "http://hub.test/callback",
      clientName: "Corbits Workbench",
    });

    expect(result.ok).toBe(false);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(report.mock.calls[0]?.[1]).toMatchObject({
      operation: "refresh_mcp_oauth_tokens",
      extra: { serverUrl },
    });
    report.mockRestore();
  });
});
