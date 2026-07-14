import { beforeEach, describe, expect, it, mock } from "bun:test";

// CL-3510 credential rail: prefer the member's own connected OAuth token over
// the shared tenant key, fall back to the tenant key, else null.

let memberToken: { accessToken: string } | null;
let tenantCred: { secret: string } | null;
let providerMetadata: { baseURL?: string } | null;

mock.module("./oauth-flow", () => ({
  resolveOAuthToken: async () => memberToken,
}));

mock.module("./credential-crypto", () => ({
  decryptToolCredentialSecret: (secret: string) => `decrypted:${secret}`,
}));

mock.module("@intx/db", () => ({
  resolveProviderByName: async () =>
    providerMetadata ? { id: "prv", metadata: providerMetadata } : null,
  resolveCredentialRequirement: async () => tenantCred,
}));

const { resolveMemberOrTenantToolCredential } = await import(
  "./member-tool-credential"
);

const db = {} as never;

describe("resolveMemberOrTenantToolCredential", () => {
  beforeEach(() => {
    memberToken = null;
    tenantCred = null;
    providerMetadata = { baseURL: "https://api.example.test" };
  });

  it("prefers the member's connected OAuth token when present", async () => {
    memberToken = { accessToken: "member-tok" };
    tenantCred = { secret: "tenant-secret" };
    const result = await resolveMemberOrTenantToolCredential(
      db,
      "ten",
      "prn",
      "linear",
    );
    expect(result).toEqual({
      apiKey: "member-tok",
      baseURL: "https://api.example.test",
      source: "member",
    });
  });

  it("falls back to the decrypted tenant credential when the member has not connected", async () => {
    memberToken = null;
    tenantCred = { secret: "tenant-secret" };
    const result = await resolveMemberOrTenantToolCredential(
      db,
      "ten",
      "prn",
      "linear",
    );
    expect(result).toEqual({
      apiKey: "decrypted:tenant-secret",
      baseURL: "https://api.example.test",
      source: "tenant",
    });
  });

  it("returns null when neither a member connection nor a tenant key exists", async () => {
    memberToken = null;
    tenantCred = null;
    expect(
      await resolveMemberOrTenantToolCredential(db, "ten", "prn", "linear"),
    ).toBeNull();
  });
});
