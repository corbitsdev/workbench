// DB-gated: skipped when no DATABASE_URL is reachable, mirroring
// `credential-delivery.drizzle.test.ts` (its own schema, never the
// developer's or the walking-skeleton suite's) and
// `@corbits/granola-tools`'s `test/credential-wiring-e2e.drizzle.test.ts`
// (CL-6032), which this test follows step for step.
//
// Proves the FULL "connect once, workflows just work" chain end to end
// through the platform's own, already-built functions -- never a
// hand-rolled resolver or a fake credential -- AND that the seeded
// provider row's `plugin: "http-raw-authorization"` reaches the tool
// call as Linear's raw-key `authorization` header, not the vendored
// `http` (Bearer) provider's shape a wrongly-seeded row would send (the
// bug a review caught; see `linear-raw-authorization-regression.test.ts`
// for the narrower regression guard):
//
//   1. seed a tenant-owned Linear credential in Postgres, on a provider
//      row whose `plugin` is `http-raw-authorization`
//      (`@corbits/credential-providers`), not `http`;
//   2. `buildCredentialDelivery` (`@intx/db`, launch-time resolution)
//      resolves this package's declared "linear" handle to that
//      credential's decrypted secret, plus the `credential:{id}` / `use`
//      grant the launch stamps;
//   3. compose the consumer-scoped `credentials` capability exactly as
//      `apps/sidecar/src/step-agent-tools.ts`'s `createToolBearingAgentFactory`
//      does at a real step build -- `createCredentialCapability`
//      (`@intx/harness`) over `createHttpRawAuthorizationCredentialProvider`
//      and `deriveResolvedBindings` (both `@corbits/credential-providers`,
//      the latter proven to agree with the sidecar's own
//      `consumerBindings` by `apps/sidecar/test/
//      credential-bindings-parity.test.ts`) -- never reimplemented here;
//   4. run this package's real `linearTools` bundle against that
//      capability and assert the tool call reaches the (stubbed) network
//      carrying the seeded secret as Linear's raw, unprefixed header.
//
// What this does NOT cover: driving the call through a real `Agent` +
// LLM inference cycle -- see the granola-tools e2e test's header comment
// for why (no scripted tool-call inference adapter exists anywhere in
// this repo today).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildCredentialDelivery,
  createDB,
  runMigrations,
  dropSchema,
} from "@intx/db";
import { schema } from "@intx/db";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { credentialAad } from "@intx/types";
import type { CredentialBinding } from "@intx/types";
import { toolConsumer } from "@intx/authz";
import type { GrantRule } from "@intx/authz";
import {
  createCredentialCapability,
  createCredentialProviderRegistry,
} from "@intx/harness";
import {
  createHttpRawAuthorizationCredentialProvider,
  deriveResolvedBindings,
  HTTP_RAW_AUTHORIZATION_PROVIDER_KEY,
} from "@corbits/credential-providers";
import type { ToolCall } from "@intx/types/runtime";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { LINEAR_LIST_RECENT_ISSUES_TOOL, linearTools } from "../src/tool";
import type { LinearEnv } from "../src/tool";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "linear_tools_credential_wiring_e2e_test";
const KEY = new Uint8Array(32).fill(13);
const CIPHER = createEnvKeyCredentialCipher(KEY);
const CONSUMER = toolConsumer("@corbits/linear-tools");

const LINEAR_BINDING: CredentialBinding = {
  package: "@corbits/linear-tools",
  handle: "linear",
  provider: "linear",
  locator: "tenant",
};

/** A delivered binding descriptor, reshaped into the launch-time `GrantRule`. */
function toGrantRule(descriptor: {
  credentialId: string;
  consumer: string;
}): GrantRule {
  return {
    id: "grant_launch_1",
    resource: `credential:${descriptor.credentialId}`,
    action: "use",
    effect: "allow",
    origin: "system",
    conditions: { tool: descriptor.consumer },
    expiresAt: null,
    roleId: null,
    principalId: null,
  };
}

describeIfDb(
  "credential wiring end to end: seed -> delivery -> capability -> tool",
  () => {
    const target = dbTargetFromUrl(
      databaseUrl ?? "postgres://localhost:5432/unused",
    );

    beforeAll(async () => {
      await runMigrations(target, { schema: SCHEMA });
    });

    afterAll(async () => {
      await dropSchema(target, { schema: SCHEMA });
    });

    test("a tenant-seeded credential reaches linearTools's tool call as Linear's raw-key header", async () => {
      const { db, close } = createDB({ ...target, schema: SCHEMA });
      try {
        await db.insert(schema.tenant).values({
          id: "tnt_credential_wiring_e2e_linear",
          name: "Credential Wiring E2E Tenant (Linear)",
          slug: "credential-wiring-e2e-tenant-linear",
          domain: "credential-wiring-e2e-linear.workbench.test",
        });
        // Seeded with `plugin: "http-raw-authorization"`: Linear's API
        // expects the raw key in `authorization`, not a Bearer token, so
        // its provider row must opt into
        // `@corbits/credential-providers`'s plugin rather than the
        // vendored `http` default other connectors use (see
        // `docs/credential-wiring.md`).
        await db.insert(schema.provider).values({
          id: "prov_linear_e2e",
          tenantId: "tnt_credential_wiring_e2e_linear",
          name: "linear",
          plugin: HTTP_RAW_AUTHORIZATION_PROVIDER_KEY,
          apiBaseUrl: "https://api.linear.app",
        });
        const credentialId = "cred_linear_e2e";
        await db.insert(schema.credential).values({
          id: credentialId,
          tenantId: "tnt_credential_wiring_e2e_linear",
          providerId: "prov_linear_e2e",
          name: "linear-key",
          type: "api_key",
          secret: await CIPHER.encrypt(
            "seeded-linear-secret",
            credentialAad(credentialId, "secret"),
          ),
          status: "active",
        });

        // Step 2: launch-time resolution, unmodified platform function.
        const result = await buildCredentialDelivery({
          db,
          tenantId: "tnt_credential_wiring_e2e_linear",
          bindings: [LINEAR_BINDING],
          creatorPrincipalId: null,
          invokerPrincipalId: null,
          credentialCipher: CIPHER,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("expected delivery to resolve");
        const delivery = result.delivery;
        if (delivery === undefined) throw new Error("expected a delivery");

        // Step 3: the exact composition
        // `createToolBearingAgentFactory`'s `credentialCapabilityFor`
        // performs at a real step build.
        const captured: { auth: string | null } = { auth: null };
        const providers = createCredentialProviderRegistry([
          createHttpRawAuthorizationCredentialProvider({
            fetch: async (_input, init) => {
              captured.auth =
                (init?.headers as Headers | undefined)?.get("authorization") ??
                null;
              return new Response(
                JSON.stringify({
                  data: {
                    issues: {
                      nodes: [
                        {
                          id: "issue_1",
                          identifier: "CL-1",
                          title: "Fix the thing",
                          updatedAt: "2026-08-12T09:00:00.000Z",
                        },
                      ],
                    },
                  },
                }),
                { status: 200 },
              );
            },
          }),
        ]);
        const capability = createCredentialCapability({
          consumer: CONSUMER,
          bindings: deriveResolvedBindings(delivery, CONSUMER),
          providers,
          grants: delivery.bindings.map(toGrantRule),
        });

        // Step 4: the real tool bundle, driven exactly as
        // `../src/tool.test.ts` drives it, sees the seeded secret in
        // Linear's expected header shape.
        const env = { credentials: capability } as unknown as LinearEnv;
        const bundle = linearTools(env);
        const call: ToolCall = {
          id: "call_1",
          name: LINEAR_LIST_RECENT_ISSUES_TOOL,
          arguments: {},
        };
        const callResult = await bundle.run(call, new AbortController().signal);

        expect(callResult.isError).toBeUndefined();
        expect(captured.auth).toBe("seeded-linear-secret");
        expect(captured.auth).not.toBe("Bearer seeded-linear-secret");
        expect(JSON.parse(callResult.content as string)).toEqual({
          issues: [
            {
              id: "issue_1",
              identifier: "CL-1",
              title: "Fix the thing",
              updatedAt: "2026-08-12T09:00:00.000Z",
            },
          ],
        });

        await capability.dispose();
      } finally {
        await close();
      }
    });
  },
);
