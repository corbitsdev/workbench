import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { HubDb } from "../db";
import { providerWebhookDelivery } from "../db/schema";
import { encryptSecret } from "./credential-crypto";
import {
  recordProviderWebhookDelivery,
  resolveProviderWebhookCredential,
} from "./provider-webhooks";

const KEY = "0".repeat(64);

beforeAll(() => {
  process.env["CREDENTIAL_ENCRYPTION_KEY"] = KEY;
});
afterAll(() => {
  delete process.env["CREDENTIAL_ENCRYPTION_KEY"];
});

function makeDb(args: {
  providerMetadata?: unknown;
  credentialSecret?: string | null;
}): HubDb {
  const db = {
    query: {
      provider: {
        findFirst: async () =>
          args.providerMetadata === undefined
            ? null
            : { id: "prov-1", metadata: args.providerMetadata },
      },
      credential: {
        findFirst: async () =>
          args.credentialSecret === undefined || args.credentialSecret === null
            ? null
            : { secret: args.credentialSecret },
      },
    },
  };
  return db as unknown as HubDb;
}

describe("resolveProviderWebhookCredential", () => {
  const adapter = {
    provider: "linear",
    tenantKeyMetadataField: "organizationId",
  };

  it("decrypts an encrypted-at-rest secret and returns the configured tenant key", async () => {
    const db = makeDb({
      providerMetadata: { organizationId: "org-1" },
      credentialSecret: encryptSecret("shh-secret"),
    });
    const resolved = await resolveProviderWebhookCredential(
      db,
      "tenant-1",
      adapter,
    );
    expect(resolved).toEqual({
      tenantId: "tenant-1",
      tenantKey: "org-1",
      secret: "shh-secret",
    });
  });

  it("returns null when no provider row exists", async () => {
    const db = makeDb({});
    expect(
      await resolveProviderWebhookCredential(db, "tenant-1", adapter),
    ).toBeNull();
  });

  it("returns null when the provider row has no value under the adapter's metadata field", async () => {
    const db = makeDb({
      providerMetadata: {},
      credentialSecret: encryptSecret("shh-secret"),
    });
    expect(
      await resolveProviderWebhookCredential(db, "tenant-1", adapter),
    ).toBeNull();
  });

  it("returns null when no credential row exists for the provider", async () => {
    const db = makeDb({
      providerMetadata: { organizationId: "org-1" },
      credentialSecret: null,
    });
    expect(
      await resolveProviderWebhookCredential(db, "tenant-1", adapter),
    ).toBeNull();
  });

  it("resolves a second, unrelated adapter's metadata field independently -- proves the naming convention generalizes", async () => {
    const db = makeDb({
      providerMetadata: { fakeWorkspaceId: "ws-9" },
      credentialSecret: encryptSecret("fake-secret"),
    });
    const resolved = await resolveProviderWebhookCredential(db, "tenant-1", {
      provider: "fake",
      tenantKeyMetadataField: "fakeWorkspaceId",
    });
    expect(resolved).toEqual({
      tenantId: "tenant-1",
      tenantKey: "ws-9",
      secret: "fake-secret",
    });
  });
});

describe("recordProviderWebhookDelivery", () => {
  function makeInsertDb(existing: Set<string>): HubDb {
    const db = {
      insert: (table: unknown) => {
        if (table !== providerWebhookDelivery) {
          throw new Error("unexpected insert target");
        }
        return {
          values: (row: { id: string }) => ({
            onConflictDoNothing: () => ({
              returning: async () => {
                if (existing.has(row.id)) return [];
                existing.add(row.id);
                return [{ id: row.id }];
              },
            }),
          }),
        };
      },
    };
    return db as unknown as HubDb;
  }

  it("returns true the first time a (provider, deliveryId) pair is recorded", async () => {
    const db = makeInsertDb(new Set());
    const isNew = await recordProviderWebhookDelivery(db, {
      provider: "linear",
      deliveryId: "d-1",
      tenantId: "tenant-1",
      tenantKey: "org-1",
      action: "update",
      entityType: "Issue",
    });
    expect(isNew).toBe(true);
  });

  it("returns false on a redelivery of the same (provider, deliveryId) pair", async () => {
    const db = makeInsertDb(new Set(["linear:d-1"]));
    const isNew = await recordProviderWebhookDelivery(db, {
      provider: "linear",
      deliveryId: "d-1",
      tenantId: "tenant-1",
      tenantKey: "org-1",
      action: "update",
      entityType: "Issue",
    });
    expect(isNew).toBe(false);
  });

  it("does not collide two different providers sharing the same raw deliveryId", async () => {
    const db = makeInsertDb(new Set(["linear:d-1"]));
    const isNew = await recordProviderWebhookDelivery(db, {
      provider: "github",
      deliveryId: "d-1",
      tenantId: "tenant-1",
      tenantKey: "org-1",
      action: "update",
      entityType: "Issue",
    });
    expect(isNew).toBe(true);
  });
});
