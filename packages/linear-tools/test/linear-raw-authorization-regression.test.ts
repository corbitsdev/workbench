// Regression guard for a bug a review caught: driving the REAL platform
// capability (`createCredentialCapability`, `@intx/harness`) and this
// package's real client through the vendored Bearer-only
// `createHttpCredentialProvider` sent `authorization: Bearer <secret>` —
// Linear's API expects the raw key verbatim, no "Bearer " prefix (the
// same convention this package's pre-credential-wiring client used
// directly). `@corbits/credential-providers`'s `http-raw-authorization`
// plugin fixes this without touching or forking the vendored provider;
// this test proves the fix by driving the REAL provider (not this
// package's own `tool.test.ts` fake) end to end and asserting the header
// Linear actually expects.
import { expect, test } from "bun:test";
import {
  createCredentialCapability,
  createCredentialProviderRegistry,
} from "@intx/harness";
import { toolConsumer } from "@intx/authz";
import {
  createHttpRawAuthorizationCredentialProvider,
  HTTP_RAW_AUTHORIZATION_PROVIDER_KEY,
} from "@corbits/credential-providers";

import { listRecentLinearIssues } from "../src/client";

test("the real http-raw-authorization provider sends Linear's raw-key convention, not Bearer", async () => {
  const captured: { auth: string | null } = { auth: null };
  const providers = createCredentialProviderRegistry([
    createHttpRawAuthorizationCredentialProvider({
      fetch: async (_input, init) => {
        captured.auth =
          (init?.headers as Headers | undefined)?.get("authorization") ?? null;
        return new Response(
          JSON.stringify({ data: { issues: { nodes: [] } } }),
          {
            status: 200,
          },
        );
      },
    }),
  ]);
  const consumer = toolConsumer("@corbits/linear-tools");
  const capability = createCredentialCapability({
    consumer,
    bindings: new Map([
      [
        "linear",
        {
          credentialId: "cred_1",
          providerKey: HTTP_RAW_AUTHORIZATION_PROVIDER_KEY,
          origin: "https://api.linear.app",
          readCurrentMaterial: () => ({ secret: "lin_api_key_real" }),
        },
      ],
    ]),
    providers,
    grants: [
      {
        id: "g1",
        resource: "credential:cred_1",
        action: "use",
        effect: "allow",
        origin: "system",
        conditions: { tool: consumer },
        expiresAt: null,
        roleId: null,
        principalId: null,
      },
    ],
  });

  const mediated = await capability.resolve("linear");
  await listRecentLinearIssues({
    fetchImpl: mediated.fetch as unknown as typeof fetch,
    baseUrl: "https://api.linear.app",
  });

  expect(captured.auth).toBe("lin_api_key_real");
  expect(captured.auth).not.toBe("Bearer lin_api_key_real");

  await capability.dispose();
});
