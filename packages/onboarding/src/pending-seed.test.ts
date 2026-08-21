// The in-memory store exercises the same encrypt/validate/TTL logic
// `createDrizzlePendingSeedStore` runs against Postgres (see
// `createPendingSeedStore` in `./pending-seed.ts`) — round-trip,
// per-provider AAD, wrong-session, expiry, and cleared-on-success all
// have to hold regardless of which `RowAccess` backs the store.
// `test/pending-seed-store.test.ts` DB-gates the same scenarios against
// the real Postgres-backed store.
import { describe, expect, test } from "bun:test";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import type { CredentialCipher } from "@intx/types";
import {
  createInMemoryPendingSeedStore,
  PENDING_SEED_TTL_MS,
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

describe("createInMemoryPendingSeedStore", () => {
  test("round-trips for the exact user and tenant it was written for", async () => {
    const store = createInMemoryPendingSeedStore(testCipher());
    await store.put(SEED);

    const read = await store.read({ userId: "user_1", tenantId: "ten_1" });

    expect(read).toEqual(SEED);
  });

  test("stays readable more than once inside its TTL — unlike the PKCE state, this is not single-use", async () => {
    const store = createInMemoryPendingSeedStore(testCipher());
    await store.put(SEED);

    const first = await store.read({ userId: "user_1", tenantId: "ten_1" });
    const second = await store.read({ userId: "user_1", tenantId: "ten_1" });

    expect(first).toEqual(SEED);
    expect(second).toEqual(SEED);
  });

  test("a row written for one user is invisible to another", async () => {
    const store = createInMemoryPendingSeedStore(testCipher());
    await store.put(SEED);

    const read = await store.read({ userId: "user_2", tenantId: "ten_1" });

    expect(read).toBeUndefined();
  });

  test("a row written for one tenant is invisible against another", async () => {
    const store = createInMemoryPendingSeedStore(testCipher());
    await store.put(SEED);

    const read = await store.read({
      userId: "user_1",
      tenantId: "ten_other",
    });

    expect(read).toBeUndefined();
  });

  test("an expired row reads as absent and is deleted, not merely ignored", async () => {
    let clock = 0;
    const store = createInMemoryPendingSeedStore(testCipher());
    await store.put(SEED, { now: () => clock });

    clock = PENDING_SEED_TTL_MS;
    const read = await store.read({
      userId: "user_1",
      tenantId: "ten_1",
      now: () => clock,
    });
    expect(read).toBeUndefined();

    // Deleted, not just expired-and-skipped: a fresh read (even with
    // the clock rewound) finds nothing, proving the row is gone.
    const rereadEarlier = await store.read({
      userId: "user_1",
      tenantId: "ten_1",
      now: () => 0,
    });
    expect(rereadEarlier).toBeUndefined();
  });

  test("a ciphertext sealed under one key is worthless after a key rotation", async () => {
    const cipher = testCipher();
    const aad = JSON.stringify(["onboarding-pending-seed", "openrouter"]);
    const payload = await cipher.encrypt(
      JSON.stringify({
        principalId: SEED.principalId,
        tenantDomain: SEED.tenantDomain,
        apiKey: SEED.apiKey,
      }),
      aad,
    );

    const rotated = createEnvKeyCredentialCipher(Buffer.alloc(32, 12));
    await expect(rotated.decrypt(payload, aad)).rejects.toThrow();
  });

  test("a fresh connect upserts over whatever pending seed came before it — one active row per (userId, tenantId)", async () => {
    const store = createInMemoryPendingSeedStore(testCipher());
    await store.put(SEED);

    const replacement: PendingSeed = {
      ...SEED,
      provider: "huggingface",
      apiKey: "hf_replaced",
    };
    await store.put(replacement);

    const read = await store.read({ userId: "user_1", tenantId: "ten_1" });
    expect(read).toEqual(replacement);
  });

  test("listDue answers every unexpired row, whoever owns it — the drain has no request to scope it", async () => {
    const store = createInMemoryPendingSeedStore(testCipher());
    await store.put(SEED);
    await store.put({
      ...SEED,
      userId: "user_2",
      tenantId: "ten_2",
      apiKey: "sk-or-v1-second",
    });

    const due = await store.listDue({});

    expect(due).toHaveLength(2);
    expect(due).toEqual(
      expect.arrayContaining([
        SEED,
        {
          ...SEED,
          userId: "user_2",
          tenantId: "ten_2",
          apiKey: "sk-or-v1-second",
        },
      ]),
    );
  });

  test("listDue drops an expired row instead of handing the drain a dead key", async () => {
    let clock = 0;
    const store = createInMemoryPendingSeedStore(testCipher());
    await store.put(SEED, { now: () => clock });
    await store.put(
      { ...SEED, userId: "user_2", tenantId: "ten_2" },
      { now: () => clock, ttlMs: PENDING_SEED_TTL_MS * 2 },
    );

    clock = PENDING_SEED_TTL_MS + 1;
    const due = await store.listDue({ now: () => clock });

    expect(due).toEqual([{ ...SEED, userId: "user_2", tenantId: "ten_2" }]);
    // Swept, not merely skipped — the expired row is gone for good.
    expect(
      await store.read({ userId: "user_1", tenantId: "ten_1", now: () => 0 }),
    ).toBeUndefined();
  });

  test("listDue honors its limit so one drain tick can never scan the whole table", async () => {
    const store = createInMemoryPendingSeedStore(testCipher());
    for (let index = 0; index < 5; index += 1) {
      await store.put({
        ...SEED,
        userId: `user_${index}`,
        tenantId: `ten_${index}`,
      });
    }

    const due = await store.listDue({ limit: 2 });

    expect(due).toHaveLength(2);
  });

  test("cleared on successful seed — the row is gone after clear", async () => {
    const store = createInMemoryPendingSeedStore(testCipher());
    await store.put(SEED);

    await store.clear({ userId: "user_1", tenantId: "ten_1" });

    const read = await store.read({ userId: "user_1", tenantId: "ten_1" });
    expect(read).toBeUndefined();
  });

  test("clearing a row that was never written is a harmless no-op", async () => {
    const store = createInMemoryPendingSeedStore(testCipher());
    await expect(
      store.clear({ userId: "user_1", tenantId: "ten_1" }),
    ).resolves.toBeUndefined();
  });

  test("round-trips for a provider other than the first — every supported provider seals and opens correctly", async () => {
    const store = createInMemoryPendingSeedStore(testCipher());
    const hfSeed: PendingSeed = { ...SEED, provider: "huggingface" };
    await store.put(hfSeed);

    const read = await store.read({ userId: "user_1", tenantId: "ten_1" });

    expect(read).toEqual(hfSeed);
  });

  test("domain separation: a ciphertext sealed for one provider's AAD cannot decrypt under another's", async () => {
    const cipher = testCipher();
    const openrouterAad = JSON.stringify([
      "onboarding-pending-seed",
      "openrouter",
    ]);
    const huggingfaceAad = JSON.stringify([
      "onboarding-pending-seed",
      "huggingface",
    ]);
    const payload = await cipher.encrypt(
      JSON.stringify({
        principalId: SEED.principalId,
        tenantDomain: SEED.tenantDomain,
        apiKey: SEED.apiKey,
      }),
      openrouterAad,
    );

    await expect(cipher.decrypt(payload, huggingfaceAad)).rejects.toThrow();
  });
});
