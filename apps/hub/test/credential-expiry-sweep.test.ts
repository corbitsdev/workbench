// The sweep's own orchestration — claim, mail, skip a no-recipient
// expiry, never double-claim — against an in-memory store. Which
// credentials are due is `@corbits/notify`'s own tested concern
// (`findDueCredentialExpiries`); this only checks the loop calls it
// correctly and behaves once a claim decision comes back.
import { describe, expect, test } from "bun:test";
import {
  createInMemoryNotifyDispatchStore,
  createSinkRegistry,
  type NotifyDeliveryDeps,
} from "@corbits/notify";
import {
  tickCredentialExpirySweep,
  type CredentialExpirySweepStore,
} from "../src/credential-expiry-sweep";
import type { ExpiringCredential } from "@corbits/notify";

type MutableExpiringCredential = {
  -readonly [K in keyof ExpiringCredential]: ExpiringCredential[K];
};

function credential(
  overrides: Partial<ExpiringCredential> = {},
): MutableExpiringCredential {
  return {
    credentialId: "cred_1",
    tenantId: "tnt_1",
    providerId: "huggingface",
    providerLabel: "Hugging Face",
    status: "active",
    expiresAt: "2026-08-13T11:00:00.000Z",
    recipients: [{ tenantId: "tnt_1", principalId: "prn_1" }],
    ...overrides,
  };
}

function inMemoryStore(
  candidates: MutableExpiringCredential[],
): CredentialExpirySweepStore & { claims: string[] } {
  const claims: string[] = [];
  return {
    claims,
    async loadActiveCandidates() {
      return candidates.filter((c) => c.status === "active");
    },
    async claimExpiry(credentialId) {
      // Emulate a conditional DB update: only succeeds once per credential.
      const found = candidates.find(
        (c) => c.credentialId === credentialId && c.status === "active",
      );
      if (!found) return false;
      claims.push(credentialId);
      found.status = "expired";
      return true;
    },
  };
}

function notifyDeps(): NotifyDeliveryDeps & {
  mailed: { tenantId: string; principalId: string }[];
} {
  const mailed: { tenantId: string; principalId: string }[] = [];
  return {
    mailed,
    mail: async (items, opts) =>
      items.map((item, index) => {
        const id = `mail-${index}`;
        mailed.push({ tenantId: item.tenantId, principalId: item.principalId });
        opts?.enqueue?.({ id, item });
        return { messageKey: item.externalId, id };
      }),
    addressing: {
      inbox: (recipient) => `${recipient.principalId}@inbox.invalid`,
      from: (kind) => `${kind}@notify.invalid`,
    },
    dispatch: createInMemoryNotifyDispatchStore(),
    sinks: createSinkRegistry(),
  };
}

const now = new Date("2026-08-13T12:00:00.000Z");

describe("tickCredentialExpirySweep", () => {
  test("claims a due credential and mails its recipients", async () => {
    const store = inMemoryStore([credential()]);
    const notify = notifyDeps();

    await tickCredentialExpirySweep({ store, notify, now: () => now });

    expect(store.claims).toEqual(["cred_1"]);
    expect(notify.mailed).toEqual([
      { tenantId: "tnt_1", principalId: "prn_1" },
    ]);
  });

  test("a credential with no active recipients is claimed but never mailed", async () => {
    const store = inMemoryStore([credential({ recipients: [] })]);
    const notify = notifyDeps();

    await tickCredentialExpirySweep({ store, notify, now: () => now });

    expect(store.claims).toEqual(["cred_1"]);
    expect(notify.mailed).toEqual([]);
  });

  test("a credential not yet expired is neither claimed nor mailed", async () => {
    const store = inMemoryStore([
      credential({ expiresAt: "2026-08-13T13:00:00.000Z" }),
    ]);
    const notify = notifyDeps();

    await tickCredentialExpirySweep({ store, notify, now: () => now });

    expect(store.claims).toEqual([]);
    expect(notify.mailed).toEqual([]);
  });

  test("a claim that loses the race (another replica already won) is never mailed", async () => {
    const store = inMemoryStore([credential()]);
    // Simulate another replica claiming first, between load and claim.
    await store.claimExpiry("cred_1", now);
    store.claims.length = 0;
    const notify = notifyDeps();

    await tickCredentialExpirySweep({ store, notify, now: () => now });

    expect(store.claims).toEqual([]);
    expect(notify.mailed).toEqual([]);
  });
});
