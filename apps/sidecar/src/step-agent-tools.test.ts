// Unit tests for the credential half of the tool-bearing step wiring
// (CL-6032): `consumerBindings` derives a consumer-scoped
// `ResolvedCredentialBinding` map from a step's live `CredentialWiring`,
// and composes with the platform's own `createCredentialCapability`
// (`vendor/intx/harness/src/credential-capability.ts`) exactly as
// `createToolBearingAgentFactory` does inside its `credentialCapabilityFor`
// closure. These tests exercise that composition directly -- a fake
// `CredentialWiring` in, a shaped `credentials` capability out -- without
// standing up a full `Agent`, which `packages/granola-tools` and
// `packages/linear-tools`'s own `tool.test.ts` suites already cover from
// the tool side (a `CredentialCapability` in, a `ToolResult` out).
import { describe, expect, test } from "bun:test";

import {
  createCredentialCapability,
  createCredentialProviderRegistry,
  createHttpCredentialProvider,
} from "@intx/harness";
import { toolConsumer } from "@intx/authz";
import type { GrantRule } from "@intx/authz";
import type { CredentialDelivery } from "@intx/types/sidecar";
import type { CredentialWiring } from "@intx/workflow-host";

import {
  consumerBindings,
  type StepCredentialContext,
} from "./step-agent-tools";

const CONSUMER = toolConsumer("@corbits/granola-tools");
const OTHER_CONSUMER = toolConsumer("@corbits/linear-tools");
const CREDENTIAL_ID = "cred_1";
const STEP_ID = "step_1";

/**
 * Provider registry stubbed with a captured-header fetch, mirroring the
 * `createSidecarSubstrateFactory` production wiring
 * (`createCredentialProviderRegistry(builtinCredentialProviders())`) but
 * with the network swapped for a spy so a test can assert on the header
 * the mediated `fetch` injected without a real HTTP call.
 */
function providersWithCapturedAuth(): {
  providers: ReturnType<typeof createCredentialProviderRegistry>;
  lastAuthHeader: () => string | null;
} {
  let captured: string | null = null;
  const providers = createCredentialProviderRegistry([
    createHttpCredentialProvider({
      fetch: async (_input, init) => {
        captured =
          (init?.headers as Headers | undefined)?.get("authorization") ?? null;
        return new Response("{}", { status: 200 });
      },
    }),
  ]);
  return { providers, lastAuthHeader: () => captured };
}

function delivery(secret: string): CredentialDelivery {
  return {
    bindings: [
      { handle: "granola", credentialId: CREDENTIAL_ID, consumer: CONSUMER },
    ],
    materials: [
      {
        credentialId: CREDENTIAL_ID,
        providerKey: "http",
        origin: "https://api.granola.ai",
        secret,
      },
    ],
  };
}

function useGrant(consumer: string): GrantRule {
  return {
    id: "grant_1",
    resource: `credential:${CREDENTIAL_ID}`,
    action: "use",
    effect: "allow",
    origin: "system",
    conditions: { tool: consumer },
    expiresAt: null,
    roleId: null,
    principalId: null,
  };
}

function wiring(
  current: CredentialDelivery | null,
  grants: readonly GrantRule[] = [useGrant(CONSUMER)],
): CredentialWiring {
  return {
    materialRef: { current },
    resolveStepGrants: () => grants,
  };
}

describe("consumerBindings", () => {
  test("derives the consumer's bound handle from a fake CredentialWiring's live delivery", () => {
    const context: StepCredentialContext = {
      wiring: wiring(delivery("s3cr3t")),
      stepId: STEP_ID,
    };
    const bindings = consumerBindings(context, CONSUMER);
    expect([...bindings.keys()]).toEqual(["granola"]);
    expect(bindings.get("granola")?.credentialId).toBe(CREDENTIAL_ID);
    expect(bindings.get("granola")?.providerKey).toBe("http");
    expect(bindings.get("granola")?.origin).toBe("https://api.granola.ai");
  });

  test("filters out a binding delivered for a different consumer", () => {
    const context: StepCredentialContext = {
      wiring: wiring(delivery("s3cr3t")),
      stepId: STEP_ID,
    };
    expect(consumerBindings(context, OTHER_CONSUMER).size).toBe(0);
  });

  test("is empty when the run carries no credential delivery at all", () => {
    const context: StepCredentialContext = {
      wiring: wiring(null),
      stepId: STEP_ID,
    };
    expect(consumerBindings(context, CONSUMER).size).toBe(0);
  });

  test("is empty when the step's env carries no credential wiring at all", () => {
    expect(consumerBindings(undefined, CONSUMER).size).toBe(0);
  });

  test("readCurrentMaterial re-reads the live materialRef, reflecting a rotation", () => {
    const ref: { current: CredentialDelivery | null } = {
      current: delivery("original-secret"),
    };
    const context: StepCredentialContext = {
      wiring: {
        materialRef: ref,
        resolveStepGrants: () => [useGrant(CONSUMER)],
      },
      stepId: STEP_ID,
    };
    const binding = consumerBindings(context, CONSUMER).get("granola");
    if (binding === undefined) throw new Error("expected a granola binding");
    expect(binding.readCurrentMaterial().secret).toBe("original-secret");

    ref.current = delivery("rotated-secret");
    expect(binding.readCurrentMaterial().secret).toBe("rotated-secret");
  });
});

describe("createCredentialCapability composed over a fake CredentialWiring", () => {
  test("a bound handle with a matching grant resolves a mediated credential the tool can use to reach the secret", async () => {
    const context: StepCredentialContext = {
      wiring: wiring(delivery("s3cr3t")),
      stepId: STEP_ID,
    };
    const { providers, lastAuthHeader } = providersWithCapturedAuth();
    const capability = createCredentialCapability({
      consumer: CONSUMER,
      bindings: consumerBindings(context, CONSUMER),
      providers,
      grants: [...context.wiring.resolveStepGrants(STEP_ID)] as GrantRule[],
    });

    const mediated = await capability.resolve("granola");
    expect(mediated.kind).toBe("http");
    await mediated.fetch("https://api.granola.ai/v1/notes");
    expect(lastAuthHeader()).toBe("Bearer s3cr3t");
    await capability.dispose();
  });

  test("an unbound handle -- absent CredentialWiring -- rejects rather than silently resolving", async () => {
    const { providers } = providersWithCapturedAuth();
    const capability = createCredentialCapability({
      consumer: CONSUMER,
      bindings: consumerBindings(undefined, CONSUMER),
      providers,
      grants: [],
    });

    await expect(capability.resolve("granola")).rejects.toThrow(
      /no credential is bound to handle/,
    );
  });

  test("a bound handle with no matching grant fails closed even though the binding exists", async () => {
    const context: StepCredentialContext = {
      wiring: wiring(delivery("s3cr3t"), [useGrant(OTHER_CONSUMER)]),
      stepId: STEP_ID,
    };
    const { providers } = providersWithCapturedAuth();
    const capability = createCredentialCapability({
      consumer: CONSUMER,
      bindings: consumerBindings(context, CONSUMER),
      providers,
      grants: [...context.wiring.resolveStepGrants(STEP_ID)] as GrantRule[],
    });

    await expect(capability.resolve("granola")).rejects.toThrow(
      /not authorized to use credential/,
    );
  });
});
