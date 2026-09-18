// Boundary readers for the sidecar's env-config inputs, centralized so
// validation rules live in one place at the boot edge.

import { AdapterManifest } from "@intx/inference";
import { hexDecode } from "@intx/types";

const DEFAULT_CACHE_MAX_BYTES = 10 * 1024 * 1024 * 1024;

// Separate from the hub's CREDENTIAL_ENCRYPTION_KEY, so a sidecar
// disk-plus-key compromise can't also decrypt the hub's database.
export function readCredentialEncryptionKey(): Uint8Array {
  const raw = process.env["SIDECAR_CREDENTIAL_ENCRYPTION_KEY"];
  if (raw === undefined || raw.trim() === "") {
    throw new Error("SIDECAR_CREDENTIAL_ENCRYPTION_KEY environment variable is required");
  }
  return hexDecode(raw);
}

export function readCacheMaxBytes(): number {
  const raw = process.env["SIDECAR_CACHE_MAX_BYTES"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_CACHE_MAX_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`SIDECAR_CACHE_MAX_BYTES must be a positive number; got ${raw}`);
  }
  return n;
}

// Mirrors the hub's DEFAULT_HUB_MAX_TARBALL_BYTES.
const DEFAULT_REGISTRY_MAX_TARBALL_BYTES = 10 * 1024 * 1024;

export function readRegistryMaxTarballBytes(): number {
  const raw = process.env["SIDECAR_REGISTRY_MAX_TARBALL_BYTES"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_REGISTRY_MAX_TARBALL_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`SIDECAR_REGISTRY_MAX_TARBALL_BYTES must be a positive number; got ${raw}`);
  }
  return n;
}

// Trusted operator input only: import(specifier) is arbitrary code
// execution, so a specifier must never originate from deploy or tenant data.
export function readAdapterManifest(): AdapterManifest {
  const raw = process.env["SIDECAR_ADAPTER_MANIFEST"];
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error("SIDECAR_ADAPTER_MANIFEST is not valid JSON", { cause });
  }
  return AdapterManifest.assert(parsed);
}
