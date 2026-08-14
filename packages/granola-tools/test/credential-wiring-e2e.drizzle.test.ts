// DB-gated: skipped when no DATABASE_URL is reachable, mirroring
// `credential-delivery.drizzle.test.ts` (its own schema, never the
// developer's or the walking-skeleton suite's).
//
// Proves the FULL "connect once, workflows just work" chain end to end
// through the platform's own, already-built functions -- never a
// hand-rolled resolver or a fake credential:
//
//   1. seed a tenant-owned Granola credential in Postgres;
//   2. `buildCredentialDelivery` (`@intx/db`, launch-time resolution)
//      resolves this package's declared "granola" handle to that
//      credential's decrypted secret, plus the `credential:{id}` / `use`
//      grant the launch stamps;
//   3. compose the consumer-scoped `credentials` capability exactly as
//      `apps/sidecar/src/step-agent-tools.ts`'s `createToolBearingAgentFactory`
//      does at a real step build -- `createCredentialCapability` +
//      `createHttpCredentialProvider` (`@intx/harness`) over
//      `deriveResolvedBindings` (`@corbits/credential-providers`, the
//      package-side twin of the sidecar's own `consumerBindings`, proven
//      to agree with it by `apps/sidecar/test/
//      credential-bindings-parity.test.ts`) -- never reimplemented here;
//   4. run this package's real `granolaTools` bundle against that
//      capability and assert the tool call reaches the (stubbed) network
//      carrying the seeded secret as a bearer token.
//
// What this does NOT cover: driving the call through a real `Agent` +
// LLM inference cycle (`agent.send()` deciding to call the tool). No
// scripted/deterministic tool-call inference adapter exists anywhere in
// this repo today (`vendor/intx/agent` ships no test fixtures for one,
// and the hub's `noop-inference` route emits an empty delta that never
// triggers a tool call) -- a genuine testing-infrastructure gap, not
// something this test works around. This test instead drives the tool
// bundle directly with a `ToolCall`, exactly as `../src/tool.test.ts`
// does, so what's new here is steps 1-3: a REAL seeded credential
// reaching the tool through the REAL substrate composition.
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
  createHttpCredentialProvider,
} from "@intx/harness";
import { deriveResolvedBindings } from "@corbits/credential-providers";
import type { ToolCall } from "@intx/types/runtime";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { GRANOLA_LIST_RECENT_NOTES_TOOL, granolaTools } from "../src/tool";
import type { GranolaEnv } from "../src/tool";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "granola_tools_credential_wiring_e2e_test";
const KEY = new Uint8Array(32).fill(11);
const CIPHER = createEnvKeyCredentialCipher(KEY);
const CONSUMER = toolConsumer("@corbits/granola-tools");

const GRANOLA_BINDING: CredentialBinding = {
  package: "@corbits/granola-tools",
  handle: "granola",
  provider: "granola",
  locator: "tenant",
};

/** The launch-time grant the resolver stamps, reshaped into a `GrantRule`. */
function toGrantRule(bindingGrant: {
  resource: string;
  conditions: { tool: string };
}): GrantRule {
  return {
    id: "grant_launch_1",
    resource: bindingGrant.resource,
    action: "use",
    effect: "allow",
    origin: "system",
    conditions: bindingGrant.conditions,
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

    test("a tenant-seeded credential reaches granolaTools's tool call as a bearer secret", async () => {
      const { db, close } = createDB({ ...target, schema: SCHEMA });
      try {
        await db.insert(schema.tenant).values({
          id: "tnt_credential_wiring_e2e",
          name: "Credential Wiring E2E Tenant",
          slug: "credential-wiring-e2e-tenant",
          domain: "credential-wiring-e2e.workbench.test",
        });
        // Seeded with `plugin: "http"`: the ONLY credential provider the
        // sidecar's `createSidecarSubstrateFactory` registers
        // (`createCredentialProviderRegistry(builtinCredentialProviders())`,
        // `@intx/harness`'s single built-in origin-pinned bearer plugin).
        await db.insert(schema.provider).values({
          id: "prov_granola_e2e",
          tenantId: "tnt_credential_wiring_e2e",
          name: "granola",
          plugin: "http",
          apiBaseUrl: "https://api.granola.ai",
        });
        const credentialId = "cred_granola_e2e";
        await db.insert(schema.credential).values({
          id: credentialId,
          tenantId: "tnt_credential_wiring_e2e",
          providerId: "prov_granola_e2e",
          name: "granola-key",
          type: "api_key",
          secret: await CIPHER.encrypt(
            "seeded-granola-secret",
            credentialAad(credentialId, "secret"),
          ),
          status: "active",
        });

        // Step 2: launch-time resolution, unmodified platform function.
        const result = await buildCredentialDelivery({
          db,
          tenantId: "tnt_credential_wiring_e2e",
          bindings: [GRANOLA_BINDING],
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
          createHttpCredentialProvider({
            fetch: async (_input, init) => {
              captured.auth =
                (init?.headers as Headers | undefined)?.get("authorization") ??
                null;
              return new Response(
                JSON.stringify({
                  notes: [
                    {
                      id: "note_1",
                      title: "Weekly sync",
                      createdAt: "2026-08-12T09:00:00.000Z",
                    },
                  ],
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
          grants: result.bindingGrants.map(toGrantRule),
        });

        // Step 4: the real tool bundle, driven exactly as
        // `../src/tool.test.ts` drives it, sees the seeded secret.
        const env = { credentials: capability } as unknown as GranolaEnv;
        const bundle = granolaTools(env);
        const call: ToolCall = {
          id: "call_1",
          name: GRANOLA_LIST_RECENT_NOTES_TOOL,
          arguments: {},
        };
        const callResult = await bundle.run(call, new AbortController().signal);

        expect(callResult.isError).toBeUndefined();
        expect(captured.auth).toBe("Bearer seeded-granola-secret");
        expect(JSON.parse(callResult.content as string)).toEqual({
          notes: [
            {
              id: "note_1",
              title: "Weekly sync",
              createdAt: "2026-08-12T09:00:00.000Z",
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
