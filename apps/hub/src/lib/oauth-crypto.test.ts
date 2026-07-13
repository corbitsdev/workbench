import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedEnvelope,
  signState,
  verifyState,
} from "./oauth-crypto";

const KEY = randomBytes(32).toString("base64");

beforeAll(() => {
  process.env["CREDENTIAL_ENCRYPTION_KEY"] = KEY;
});
afterAll(() => {
  delete process.env["CREDENTIAL_ENCRYPTION_KEY"];
});

describe("envelope encryption", () => {
  test("round-trips a secret", () => {
    const envelope = encryptSecret("lin_oauth_access_token_123");
    expect(isEncryptedEnvelope(envelope)).toBe(true);
    expect(envelope).not.toContain("lin_oauth_access_token_123");
    expect(decryptSecret(envelope)).toBe("lin_oauth_access_token_123");
  });

  test("distinct ciphertexts for the same plaintext (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  test("a tampered ciphertext fails the auth tag rather than returning garbage", () => {
    const envelope = encryptSecret("secret");
    const parts = envelope.split(":");
    const flipped = Buffer.from(parts[3]!, "base64");
    flipped[0] = flipped[0]! ^ 0xff;
    parts[3] = flipped.toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  test("refuses to decrypt a non-envelope value (plaintext row)", () => {
    expect(() => decryptSecret("plain-legacy-token")).toThrow(/envelope/);
  });

  test("missing key fails loudly, never silently", () => {
    delete process.env["CREDENTIAL_ENCRYPTION_KEY"];
    expect(() => encryptSecret("x")).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
    process.env["CREDENTIAL_ENCRYPTION_KEY"] = KEY;
  });

  test("a key of the wrong length is rejected", () => {
    process.env["CREDENTIAL_ENCRYPTION_KEY"] = "too-short";
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
    process.env["CREDENTIAL_ENCRYPTION_KEY"] = KEY;
  });
});

describe("signed OAuth state", () => {
  const secret = "better-auth-secret";
  const payload = {
    nonce: "n1",
    provider: "linear",
    tenantId: "ten-1",
    memberPrincipalId: "prn-1",
    issuedAt: 1000,
  };

  test("verify accepts a well-signed state and recovers the payload", () => {
    const token = signState(payload, secret);
    expect(verifyState(token, secret)).toEqual(payload);
  });

  test("verify rejects a tampered body", () => {
    const token = signState(payload, secret);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...payload, memberPrincipalId: "prn-attacker" }),
    ).toString("base64url");
    expect(verifyState(`${forged}.${sig}`, secret)).toBeNull();
    expect(body).not.toBe(forged);
  });

  test("verify rejects a state signed with a different secret", () => {
    const token = signState(payload, secret);
    expect(verifyState(token, "other-secret")).toBeNull();
  });

  test("verify rejects a validly-SIGNED but malformed payload (parse, not cast)", () => {
    // A payload missing required fields / with wrong types, signed correctly —
    // the arktype parse at the boundary must still reject it.
    const badBody = Buffer.from(
      JSON.stringify({ nonce: 123, provider: "linear" }),
    ).toString("base64url");
    const sig = createHmac("sha256", secret)
      .update(badBody)
      .digest()
      .toString("base64url");
    expect(verifyState(`${badBody}.${sig}`, secret)).toBeNull();
  });
});
