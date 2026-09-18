// One credential capability per package (not one shared per step), since
// sharing across packages would let package A's grant authorize package
// B's resolve. Two fail-closed invariants: material is read from the live
// delivery cell on every use (not snapshotted), so revocation takes effect
// at the material rather than only at the launch-time grant gate; and the
// declared-vs-bound reconcile runs per consumer against its own bound set.

import { toolConsumer } from "@intx/authz";
import {
  createCredentialCapability,
  reconcileDeclaredCredentials,
  type CredentialProviderRegistry,
  type HostCredentialCapability,
  type ResolvedCredentialBinding,
} from "@intx/harness";
import type {
  CredentialMaterial,
  CredentialMaterialResolver,
  CredentialMaterialSource,
} from "@intx/types";
import type { GrantRule } from "@intx/types/authz";
import type { CredentialDelivery } from "@intx/types/sidecar";

import type { StepToolFactory } from "./tool-materialization";

/** Held structurally so this module stays free of the transport package and a test can use a plain object. */
export interface CredentialMaterialCell {
  readonly current: CredentialDelivery | null;
}

/** Assembled at the invoke-step boundary: material cell and grants ride in from the run child; providers are sidecar-static. */
export interface StepCredentialWiring {
  readonly materialCell: CredentialMaterialCell;
  /**
   * A thunk, not a resolved array: a resumed run may not yet have the
   * grants snapshot a Gate-2 read needs, and a toolless resume must not
   * fault on that.
   */
  readonly resolveGrants: () => readonly GrantRule[];
  readonly providers: CredentialProviderRegistry;
}

/**
 * A package with neither declared nor bound credentials gets no entry, so
 * resolve("credentials") fails closed rather than handing back an empty
 * sub-registry. Every returned capability owns a dispose the caller must run.
 */
export function buildCredentialCapabilities(
  factories: readonly StepToolFactory[],
  wiring: StepCredentialWiring,
): Map<string, HostCredentialCapability> {
  const byPackage = new Map<string, HostCredentialCapability>();
  const seenPackages = new Set<string>();
  let grants: readonly GrantRule[] | undefined;

  for (const stf of factories) {
    if (seenPackages.has(stf.packageName)) continue;
    seenPackages.add(stf.packageName);

    const consumer = toolConsumer(stf.packageName);
    const bindings = buildConsumerBindings(consumer, wiring.materialCell);

    // Fail closed against this consumer's own bound set only.
    reconcileDeclaredCredentials(consumer, stf.declaredCredentials, new Set(bindings.keys()));

    if (stf.declaredCredentials.length === 0 && bindings.size === 0) {
      continue;
    }

    grants ??= wiring.resolveGrants();
    byPackage.set(
      stf.packageName,
      createCredentialCapability({
        consumer,
        bindings,
        providers: wiring.providers,
        grants: [...grants],
      }),
    );
  }

  return byPackage;
}

/** A descriptor addressed to this consumer with no matching material is a malformed delivery and fails closed. */
function buildConsumerBindings(
  consumer: string,
  cell: CredentialMaterialCell,
): Map<string, ResolvedCredentialBinding> {
  const bindings = new Map<string, ResolvedCredentialBinding>();
  const delivery = cell.current;
  if (delivery === null) return bindings;

  for (const descriptor of delivery.bindings) {
    if (descriptor.consumer !== consumer) continue;

    const material = delivery.materials.find(
      (entry) => entry.credentialId === descriptor.credentialId,
    );
    if (material === undefined) {
      throw new Error(
        `credential delivery is malformed: descriptor for handle "${descriptor.handle}" (consumer ${consumer}) references credential ${descriptor.credentialId} but the delivery carries no material for it`,
      );
    }

    // provider/origin are pinned at build time; the secret is read live.
    bindings.set(descriptor.handle, {
      credentialId: descriptor.credentialId,
      providerKey: material.providerKey,
      origin: material.origin,
      readCurrentMaterial: makeReadCurrentMaterial({
        cell,
        credentialId: descriptor.credentialId,
        providerKey: material.providerKey,
        origin: material.origin,
        consumer,
      }),
    });
  }

  return bindings;
}

/** Reads the live cell on every call so a re-push's revocation takes effect immediately. */
function makeReadCurrentMaterial(args: {
  cell: CredentialMaterialCell;
  credentialId: string;
  providerKey: string;
  origin: string;
  consumer: string;
}): CredentialMaterialSource {
  const { cell, credentialId, providerKey, origin, consumer } = args;
  return () => {
    const delivery = cell.current;
    if (delivery === null) {
      throw new Error(
        `credential material for ${credentialId} (consumer ${consumer}) is not available: the delivery cell is empty`,
      );
    }
    const material = delivery.materials.find((entry) => entry.credentialId === credentialId);
    if (material === undefined) {
      throw new Error(
        `credential material for ${credentialId} (consumer ${consumer}) is no longer delivered: a re-push dropped it (rotated away or revoked)`,
      );
    }
    // A rotation changes only the secret; a provider/origin drift would mean
    // the handle now authenticates somewhere it wasn't pinned to.
    if (material.providerKey !== providerKey || material.origin !== origin) {
      throw new Error(
        `credential ${credentialId} changed provider/origin under an already-shaped handle (${providerKey}@${origin} -> ${material.providerKey}@${material.origin}); a shaped handle cannot follow that change`,
      );
    }
    return { secret: material.secret };
  };
}

/**
 * Unlike makeReadCurrentMaterial, pins no provider/origin: an inference
 * request authenticates to its own baseURL, so there's no handle to
 * protect against origin drift.
 */
export function createInferenceCredentialResolver(
  cell: CredentialMaterialCell,
): CredentialMaterialResolver {
  return (credentialId: string): CredentialMaterial => {
    const delivery = cell.current;
    if (delivery === null) {
      throw new Error(
        `inference credential material for ${credentialId} is not available: the delivery cell is empty`,
      );
    }
    const material = delivery.materials.find((entry) => entry.credentialId === credentialId);
    if (material === undefined) {
      throw new Error(
        `inference credential material for ${credentialId} is no longer delivered: a re-push dropped it (rotated away or revoked)`,
      );
    }
    return { secret: material.secret };
  };
}
