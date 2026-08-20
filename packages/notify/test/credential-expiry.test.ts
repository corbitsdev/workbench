import { describe, expect, test } from "bun:test";

import { findDueCredentialExpiries } from "../src/credential-expiry";
import type { ExpiringCredential } from "../src/credential-expiry";

const now = new Date("2026-08-13T12:00:00.000Z");

function credential(
  overrides: Partial<ExpiringCredential> = {},
): ExpiringCredential {
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

describe("findDueCredentialExpiries", () => {
  test("an active credential past its expiry is due", () => {
    const due = findDueCredentialExpiries([credential()], now);
    expect(due).toHaveLength(1);
    expect(due[0]?.event).toEqual({
      kind: "credential-expired",
      tenantId: "tnt_1",
      credentialId: "cred_1",
      providerId: "huggingface",
      providerLabel: "Hugging Face",
      recipients: [{ tenantId: "tnt_1", principalId: "prn_1" }],
      createdAt: now.toISOString(),
    });
  });

  test("a credential expiring exactly at now is due", () => {
    const due = findDueCredentialExpiries(
      [credential({ expiresAt: now.toISOString() })],
      now,
    );
    expect(due).toHaveLength(1);
  });

  test("a credential not yet expired is not due", () => {
    const due = findDueCredentialExpiries(
      [credential({ expiresAt: "2026-08-13T13:00:00.000Z" })],
      now,
    );
    expect(due).toHaveLength(0);
  });

  test("a durable credential with no expiry is never due", () => {
    const due = findDueCredentialExpiries(
      [credential({ expiresAt: undefined })],
      now,
    );
    expect(due).toHaveLength(0);
  });

  test("an already-expired credential is not re-decided", () => {
    const due = findDueCredentialExpiries(
      [credential({ status: "expired" })],
      now,
    );
    expect(due).toHaveLength(0);
  });

  test("a revoked or errored credential is not swept either", () => {
    const due = findDueCredentialExpiries(
      [credential({ status: "revoked" }), credential({ status: "error" })],
      now,
    );
    expect(due).toHaveLength(0);
  });

  test("an unparseable expiresAt is skipped rather than crashing", () => {
    const due = findDueCredentialExpiries(
      [credential({ expiresAt: "not-a-date" })],
      now,
    );
    expect(due).toHaveLength(0);
  });

  test("preserves candidate order across a mixed batch", () => {
    const due = findDueCredentialExpiries(
      [
        credential({ credentialId: "cred_a" }),
        credential({ credentialId: "cred_b", expiresAt: undefined }),
        credential({ credentialId: "cred_c" }),
      ],
      now,
    );
    expect(due.map((d) => d.credential.credentialId)).toEqual([
      "cred_a",
      "cred_c",
    ]);
  });
});
