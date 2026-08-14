// The PKCE and single-use state primitives shared by every connect flow:
// the S256 challenge must match RFC 7636 exactly (each provider
// recomputes it from the verifier sent back at exchange time), and the
// state store must give a verifier out exactly once and never across
// users or past its TTL.
import { describe, expect, test } from "bun:test";
import {
  createConnectStateStore,
  generatePKCEPair,
  s256Challenge,
} from "./pkce";

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
  test("a state yields its verifier exactly once", () => {
    const store = createConnectStateStore();
    const state = store.issue({ userId: "user_1", codeVerifier: "v1" });

    expect(store.consume({ state, userId: "user_1" })).toBe("v1");
    expect(store.consume({ state, userId: "user_1" })).toBeUndefined();
  });

  test("a state issued for one user is worthless to another", () => {
    const store = createConnectStateStore();
    const state = store.issue({ userId: "user_1", codeVerifier: "v1" });

    expect(store.consume({ state, userId: "user_2" })).toBeUndefined();
    // Consumed by the attempt: single-use means gone, not retryable.
    expect(store.consume({ state, userId: "user_1" })).toBeUndefined();
  });

  test("an unknown state yields nothing", () => {
    const store = createConnectStateStore();
    expect(
      store.consume({ state: "never-issued", userId: "user_1" }),
    ).toBeUndefined();
  });

  test("an expired state yields nothing", () => {
    let clock = 0;
    const store = createConnectStateStore({ ttlMs: 1000, now: () => clock });
    const state = store.issue({ userId: "user_1", codeVerifier: "v1" });

    clock = 999;
    const fresh = store.issue({ userId: "user_1", codeVerifier: "v2" });
    clock = 1000;
    expect(store.consume({ state, userId: "user_1" })).toBeUndefined();
    expect(store.consume({ state: fresh, userId: "user_1" })).toBe("v2");
  });
});
