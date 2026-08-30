import { describe, expect, test } from "bun:test";
import { createMcpOAuthProvider } from "./mcp-oauth";

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
