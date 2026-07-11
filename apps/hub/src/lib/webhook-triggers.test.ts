import { describe, expect, it } from "bun:test";
import {
  createOwnerWebhookTrigger,
  generateTriggerSecret,
  secretMatchesHash,
} from "./webhook-triggers";

describe("generateTriggerSecret", () => {
  it("produces distinct 64-hex-character secrets", () => {
    const a = generateTriggerSecret();
    const b = generateTriggerSecret();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("secretMatchesHash", () => {
  it("matches the plaintext secret createOwnerWebhookTrigger returns against the hash it persists, and rejects a wrong secret", async () => {
    let capturedValues: Record<string, unknown> | undefined;
    const db = {
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          capturedValues = values;
          return {
            returning: async () => [
              {
                id: "trig-1",
                tenantId: "tenant-1",
                ownerMemberPrincipalId: "principal-1",
                workflowKind: "deck",
                secretHash: values["secretHash"],
                enabled: true,
                createdAt: new Date(),
                lastFiredAt: null,
              },
            ],
          };
        },
      }),
    };

    const { secret } = await createOwnerWebhookTrigger(
      db as unknown as Parameters<typeof createOwnerWebhookTrigger>[0],
      { tenantId: "tenant-1", ownerPrincipalId: "principal-1", kind: "deck" },
    );
    const storedHash = capturedValues?.["secretHash"] as string;

    expect(secretMatchesHash(secret, storedHash)).toBe(true);
    expect(secretMatchesHash("wrong-secret", storedHash)).toBe(false);
  });

  it("treats a hash of different length as a non-match rather than throwing", () => {
    expect(secretMatchesHash("abc", "00")).toBe(false);
  });
});
