// One `CryptoProvider` per cache key, minted once and reused while the
// key stays active. A caller picks its own key (a workbench id, a run
// id, ...); this module knows nothing about what the key means.
import { createEd25519Crypto, generateKeyPair } from "@intx/crypto";
import { createExpiringMap } from "@corbits/collections";
import type { CryptoProvider } from "@intx/types/runtime";

export type CryptoProviderCache = {
  get(key: string): Promise<CryptoProvider>;
};

/** A key untouched for this long is treated as gone rather than idle. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createCryptoProviderCache(options?: {
  readonly ttlMs?: number;
  readonly now?: () => number;
}): CryptoProviderCache {
  const providers = createExpiringMap<string, Promise<CryptoProvider>>({
    ttlMs: options?.ttlMs ?? DEFAULT_TTL_MS,
    ...(options?.now !== undefined ? { now: options.now } : {}),
  });

  return {
    get(key: string): Promise<CryptoProvider> {
      const pending = providers.get(key);
      if (pending !== undefined) {
        providers.set(key, pending);
        return pending;
      }
      const minted = generateKeyPair().then((keyPair) =>
        createEd25519Crypto(keyPair),
      );
      providers.set(key, minted);
      return minted;
    },
  };
}
