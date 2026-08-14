// The pending-seed cookie carries a just-connected credential's
// plaintext key from the OAuth callback (fast path, never deploys) to
// the onboarding page's follow-up request (slow path, `ensureSeeded`).
// It must round-trip only for the exact user and tenant it was sealed
// for, reject anything expired or tampered with, and — deliberately
// unlike the PKCE connect state — stay redeemable more than once inside
// its TTL, since the workflow-deploy step it feeds is itself idempotent.
import { describe, expect, test } from "bun:test";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import type { CredentialCipher } from "@intx/types";
import {
  openPendingSeed,
  PENDING_SEED_TTL_MS,
  sealPendingSeed,
  type PendingSeed,
} from "./pending-seed";

const TEST_KEY = Buffer.alloc(32, 11);
function testCipher(): CredentialCipher {
  return createEnvKeyCredentialCipher(TEST_KEY);
}

const SEED: PendingSeed = {
  userId: "user_1",
  tenantId: "ten_1",
  principalId: "prn_1",
  tenantDomain: "alice-user1.bench.local",
  provider: "openrouter",
  apiKey: "sk-or-v1-minted",
};

describe("sealPendingSeed / openPendingSeed", () => {
  test("round-trips for the exact user and tenant it was sealed for", async () => {
    const cipher = testCipher();
    const token = await sealPendingSeed(cipher, SEED);

    const opened = await openPendingSeed(cipher, token, {
      userId: "user_1",
      tenantId: "ten_1",
    });

    expect(opened).toEqual(SEED);
  });

  test("stays redeemable more than once inside its TTL — unlike the PKCE state, this is not single-use", async () => {
    const cipher = testCipher();
    const token = await sealPendingSeed(cipher, SEED);

    const first = await openPendingSeed(cipher, token, {
      userId: "user_1",
      tenantId: "ten_1",
    });
    const second = await openPendingSeed(cipher, token, {
      userId: "user_1",
      tenantId: "ten_1",
    });

    expect(first).toEqual(SEED);
    expect(second).toEqual(SEED);
  });

  test("a token sealed for one user is worthless to another", async () => {
    const cipher = testCipher();
    const token = await sealPendingSeed(cipher, SEED);

    const opened = await openPendingSeed(cipher, token, {
      userId: "user_2",
      tenantId: "ten_1",
    });

    expect(opened).toBeUndefined();
  });

  test("a token sealed for one tenant is worthless against another", async () => {
    const cipher = testCipher();
    const token = await sealPendingSeed(cipher, SEED);

    const opened = await openPendingSeed(cipher, token, {
      userId: "user_1",
      tenantId: "ten_other",
    });

    expect(opened).toBeUndefined();
  });

  test("an expired token yields nothing", async () => {
    let clock = 0;
    const cipher = testCipher();
    const token = await sealPendingSeed(cipher, SEED, { now: () => clock });

    clock = PENDING_SEED_TTL_MS;
    const opened = await openPendingSeed(cipher, token, {
      userId: "user_1",
      tenantId: "ten_1",
      now: () => clock,
    });

    expect(opened).toBeUndefined();
  });

  test("an unknown or corrupt token yields nothing", async () => {
    const cipher = testCipher();
    const opened = await openPendingSeed(cipher, "not-a-real-token", {
      userId: "user_1",
      tenantId: "ten_1",
    });

    expect(opened).toBeUndefined();
  });

  test("a token sealed under a different key is worthless after a key rotation", async () => {
    const token = await sealPendingSeed(testCipher(), SEED);
    const rotated = createEnvKeyCredentialCipher(Buffer.alloc(32, 12));

    const opened = await openPendingSeed(rotated, token, {
      userId: "user_1",
      tenantId: "ten_1",
    });

    expect(opened).toBeUndefined();
  });
});
