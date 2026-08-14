// Drift guard (review follow-up, CL-6032): `apps/sidecar/src/
// step-agent-tools.ts`'s `consumerBindings` derives a consumer's
// ResolvedCredentialBinding map from a step's live `CredentialWiring`
// (a ref-holding indirection this app owns); `@corbits/credential-providers`'s
// `deriveResolvedBindings` performs the same derivation over a plain
// `CredentialDelivery` value so tool-package tests (which must never
// import an app -- "apps stay generic; packages own the domain" runs one
// direction only) can compose the real capability without duplicating
// the loop. Both exist because the two callers hold different inputs
// (a live ref vs. a resolved value); this test proves they agree on
// every input shape rather than trusting that by inspection.
import { describe, expect, test } from "bun:test";
import type { CredentialDelivery } from "@intx/types/sidecar";
import { deriveResolvedBindings } from "@corbits/credential-providers";

import {
  consumerBindings,
  type StepCredentialContext,
} from "../src/step-agent-tools";

const CONSUMER = "tool:@corbits/granola-tools";
const OTHER_CONSUMER = "tool:@corbits/linear-tools";
const CREDENTIAL_ID = "cred_parity_1";

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

function contextFor(current: CredentialDelivery | null): StepCredentialContext {
  return {
    wiring: {
      materialRef: { current },
      resolveStepGrants: () => [],
    },
    stepId: "step_parity",
  };
}

describe("consumerBindings (sidecar) vs deriveResolvedBindings (@corbits/credential-providers)", () => {
  test("agree on the bound handle's static fields for a matching consumer", () => {
    const context = contextFor(delivery("s3cr3t"));
    const fromSidecar = consumerBindings(context, CONSUMER);
    const fromGranolaCopy = deriveResolvedBindings(
      delivery("s3cr3t"),
      CONSUMER,
    );

    expect([...fromSidecar.keys()]).toEqual([...fromGranolaCopy.keys()]);
    const sidecarBinding = fromSidecar.get("granola");
    const copyBinding = fromGranolaCopy.get("granola");
    expect(sidecarBinding?.credentialId).toBe(copyBinding?.credentialId);
    expect(sidecarBinding?.providerKey).toBe(copyBinding?.providerKey);
    expect(sidecarBinding?.origin).toBe(copyBinding?.origin);
  });

  test("agree on the secret readCurrentMaterial resolves, including after a rotation", () => {
    const originalDelivery = delivery("original-secret");
    const ref: { current: CredentialDelivery | null } = {
      current: originalDelivery,
    };
    const context: StepCredentialContext = {
      wiring: { materialRef: ref, resolveStepGrants: () => [] },
      stepId: "step_parity",
    };
    const sidecarBinding = consumerBindings(context, CONSUMER).get("granola");
    const copyBinding = deriveResolvedBindings(originalDelivery, CONSUMER).get(
      "granola",
    );
    if (sidecarBinding === undefined || copyBinding === undefined) {
      throw new Error("expected both derivations to bind the granola handle");
    }
    expect(sidecarBinding.readCurrentMaterial().secret).toBe(
      copyBinding.readCurrentMaterial().secret,
    );

    // The sidecar's binding re-reads the live ref (rotation-safe); the
    // granola-tools copy captures its `delivery` argument once and is
    // NOT expected to reflect a later rotation of a ref it was never
    // given -- this only re-derives it from the rotated value directly,
    // matching how the e2e test always re-derives per call.
    const rotatedDelivery = delivery("rotated-secret");
    ref.current = rotatedDelivery;
    expect(sidecarBinding.readCurrentMaterial().secret).toBe("rotated-secret");
    const copyBindingAfterRotation = deriveResolvedBindings(
      rotatedDelivery,
      CONSUMER,
    ).get("granola");
    expect(copyBindingAfterRotation?.readCurrentMaterial().secret).toBe(
      "rotated-secret",
    );
  });

  test("agree on filtering out a binding for a different consumer", () => {
    const d = delivery("s3cr3t");
    const context = contextFor(d);
    expect(consumerBindings(context, OTHER_CONSUMER).size).toBe(0);
    expect(deriveResolvedBindings(d, OTHER_CONSUMER).size).toBe(0);
  });

  test("agree on an empty delivery yielding no bindings", () => {
    const context = contextFor(null);
    expect(consumerBindings(context, CONSUMER).size).toBe(0);
    expect(
      deriveResolvedBindings({ bindings: [], materials: [] }, CONSUMER).size,
    ).toBe(0);
  });
});
