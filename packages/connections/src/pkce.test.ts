// The PKCE and single-use state primitives shared by every connect flow:
// the S256 challenge must match RFC 7636 exactly (each provider
// recomputes it from the verifier sent back at exchange time), and the
// state store must give a verifier out exactly once, never across users
// or providers, never past its TTL, and — because the state is now a
// signed/encrypted token rather than a server-side map lookup — never
// across a process restart either, as long as the cipher key is stable.
import { describe, expect, test } from "bun:test";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import type { CredentialCipher } from "@intx/types";
import {
  createConnectStateStore,
  generatePKCEPair,
  s256Challenge,
} from "./pkce";

// A stable 32-byte test key, standing in for `CREDENTIAL_ENCRYPTION_KEY`.
// Two ciphers built from the same key bytes behave like one cipher
// surviving a restart; a cipher built from different bytes behaves like
// the key rotating out from under a still-pending state.
const TEST_KEY = Buffer.alloc(32, 7);
function testCipher(): CredentialCipher {
  return createEnvKeyCredentialCipher(TEST_KEY);
}

describe("generatePKCEPair", () => {
  test("verifier and challenge are base64url with no padding", async () => {
    const pair = await generatePKCEPair();
    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("challenge is the S256 of the verifier", async () => {
    const pair = await generatePKCEPair();
    expect(await s256Challenge(pair.codeVerifier)).toBe(pair.codeChallenge);
  });

  test("s256Challenge matches the RFC 7636 appendix vector", async () => {
    expect(
      await s256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("every pair is fresh", async () => {
    const first = await generatePKCEPair();
    const second = await generatePKCEPair();
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
  });
});

describe("createConnectStateStore", () => {
  test("a state yields its verifier exactly once", async () => {
    const store = createConnectStateStore({
      cipher: testCipher(),
      provider: "openrouter",
    });
    const state = await store.issue({ userId: "user_1", codeVerifier: "v1" });

    expect(await store.consume({ state, userId: "user_1" })).toBe("v1");
    expect(await store.consume({ state, userId: "user_1" })).toBeUndefined();
  });

  test("a state issued for one user is worthless to another", async () => {
    const store = createConnectStateStore({
      cipher: testCipher(),
      provider: "openrouter",
    });
    const state = await store.issue({ userId: "user_1", codeVerifier: "v1" });

    expect(await store.consume({ state, userId: "user_2" })).toBeUndefined();
    // Consumed by the attempt: single-use means gone, not retryable —
    // even by the rightful user.
    expect(await store.consume({ state, userId: "user_1" })).toBeUndefined();
  });

  test("an unknown state yields nothing", async () => {
    const store = createConnectStateStore({
      cipher: testCipher(),
      provider: "openrouter",
    });
    expect(
      await store.consume({ state: "never-issued", userId: "user_1" }),
    ).toBeUndefined();
  });

  test("an expired state yields nothing", async () => {
    let clock = 0;
    const store = createConnectStateStore({
      cipher: testCipher(),
      provider: "openrouter",
      ttlMs: 1000,
      now: () => clock,
    });
    const state = await store.issue({ userId: "user_1", codeVerifier: "v1" });

    clock = 999;
    const fresh = await store.issue({
      userId: "user_1",
      codeVerifier: "v2",
    });
    clock = 1000;
    expect(await store.consume({ state, userId: "user_1" })).toBeUndefined();
    expect(await store.consume({ state: fresh, userId: "user_1" })).toBe("v2");
  });

  test("a state minted for one provider is worthless to another's callback", async () => {
    const cipher = testCipher();
    const openrouterStore = createConnectStateStore({
      cipher,
      provider: "openrouter",
    });
    const huggingfaceStore = createConnectStateStore({
      cipher,
      provider: "huggingface",
    });
    const state = await openrouterStore.issue({
      userId: "user_1",
      codeVerifier: "v1",
    });

    expect(
      await huggingfaceStore.consume({ state, userId: "user_1" }),
    ).toBeUndefined();
    // The rightful provider can still redeem it — the cross-provider
    // attempt didn't burn it (it never decrypted under that provider's
    // AAD in the first place).
    expect(await openrouterStore.consume({ state, userId: "user_1" })).toBe(
      "v1",
    );
  });

  test("survives a restart: a new store built from the same key redeems a state minted before it existed", async () => {
    const before = createConnectStateStore({
      cipher: testCipher(),
      provider: "openrouter",
    });
    const state = await before.issue({
      userId: "user_1",
      codeVerifier: "v1",
    });

    // Simulates a process restart: a brand-new store, sharing nothing in
    // memory with `before`, built from a fresh cipher over the same
    // stable key bytes (as a stable CREDENTIAL_ENCRYPTION_KEY would
    // produce across a real restart).
    const after = createConnectStateStore({
      cipher: testCipher(),
      provider: "openrouter",
    });

    expect(await after.consume({ state, userId: "user_1" })).toBe("v1");
    // Single-use survives the restart boundary too: replaying the same
    // state against the post-restart store fails.
    expect(await after.consume({ state, userId: "user_1" })).toBeUndefined();
  });

  test("a key rotation invalidates every state minted under the old key", async () => {
    const before = createConnectStateStore({
      cipher: testCipher(),
      provider: "openrouter",
    });
    const state = await before.issue({
      userId: "user_1",
      codeVerifier: "v1",
    });

    const rotatedKey = Buffer.alloc(32, 9);
    const after = createConnectStateStore({
      cipher: createEnvKeyCredentialCipher(rotatedKey),
      provider: "openrouter",
    });

    expect(await after.consume({ state, userId: "user_1" })).toBeUndefined();
  });
});
