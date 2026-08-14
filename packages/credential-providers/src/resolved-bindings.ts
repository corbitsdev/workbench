// Reshape a launch-time `CredentialDelivery` into the
// `ResolvedCredentialBinding` map `@intx/harness`'s
// `createCredentialCapability` consumes for one consumer.
//
// This is the same derivation `apps/sidecar/src/step-agent-tools.ts`'s
// `consumerBindings` performs from a step's live `CredentialWiring` --
// but that function lives in the sidecar APP, and "apps stay generic;
// packages own the domain" runs one direction only: a package (this one,
// or a tool package's own tests) must never import an app. This is the
// package-side twin any tool package or test that needs the same
// delivery -> bindings shape can depend on as a real dependency, rather
// than each hand-copying the loop. `apps/sidecar/test/
// credential-bindings-parity.test.ts` is the drift guard proving the
// sidecar's live-ref version and this plain-delivery version agree.
import type { CredentialDelivery } from "@intx/types/sidecar";
import type { ResolvedCredentialBinding } from "@intx/harness";

/**
 * Derive one consumer's bound credential handles from a `CredentialDelivery`.
 * A binding delivered for a different consumer is skipped; a binding whose
 * `credentialId` has no matching `materials` entry is skipped rather than
 * thrown -- `buildCredentialDelivery` always pairs the two, so a caller
 * driving a REAL delivery never hits this, and a hand-built test fixture
 * that omits a material simply yields no binding for that handle.
 */
export function deriveResolvedBindings(
  delivery: CredentialDelivery,
  consumer: string,
): ReadonlyMap<string, ResolvedCredentialBinding> {
  const bindings = new Map<string, ResolvedCredentialBinding>();
  for (const binding of delivery.bindings) {
    if (binding.consumer !== consumer) continue;
    const material = delivery.materials.find(
      (entry) => entry.credentialId === binding.credentialId,
    );
    if (material === undefined) continue;
    bindings.set(binding.handle, {
      credentialId: binding.credentialId,
      providerKey: material.providerKey,
      origin: material.origin,
      readCurrentMaterial: () => ({ secret: material.secret }),
    });
  }
  return bindings;
}
