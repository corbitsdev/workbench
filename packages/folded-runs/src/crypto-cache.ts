// One `CryptoProvider` per cache key, minted once and reused for the
// cache's lifetime — mirroring the per-instance signing-key cache the
// platform's own mail route keeps. A caller picks its own key (a
// workbench id, an instance id, ...); this module knows nothing about
// what the key means.
import { createEd25519Crypto, generateKeyPair } from "@intx/crypto";
import type { CryptoProvider } from "@intx/types/runtime";

export type CryptoProviderCache = {
  get(key: string): Promise<CryptoProvider>;
};

export function createCryptoProviderCache(): CryptoProviderCache {
  // Never evicted: a key going momentarily unreachable (idle sleep, a
  // sweep) does not mean it is gone for good, so tearing this down on
  // that signal would rotate its signing key on the next wake for no
  // reason. Grows only with the number of distinct keys this process
  // ever mints a provider for, not by traffic.
  const providers = new Map<string, Promise<CryptoProvider>>();

  return {
    get(key: string): Promise<CryptoProvider> {
      let pending = providers.get(key);
      if (pending !== undefined) return pending;
      pending = generateKeyPair().then((keyPair) =>
        createEd25519Crypto(keyPair),
      );
      providers.set(key, pending);
      return pending;
    },
  };
}
