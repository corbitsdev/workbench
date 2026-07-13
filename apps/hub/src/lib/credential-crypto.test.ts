import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  decryptSecret,
  decryptToolCredentialSecret,
  encryptSecret,
  isEncryptedEnvelope,
} from "./credential-crypto";

const KEY = randomBytes(32).toString("base64");

beforeAll(() => {
  process.env["CREDENTIAL_ENCRYPTION_KEY"] = KEY;
});
afterAll(() => {
  delete process.env["CREDENTIAL_ENCRYPTION_KEY"];
});

describe("envelope encryption", () => {
  test("round-trips a secret", () => {
    const envelope = encryptSecret("gamma_api_key_123");
    expect(isEncryptedEnvelope(envelope)).toBe(true);
    expect(envelope).not.toContain("gamma_api_key_123");
    expect(decryptSecret(envelope)).toBe("gamma_api_key_123");
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
});

describe("decryptToolCredentialSecret (read-side resolver, CL-3446)", () => {
  test("decrypts a v1 envelope back to plaintext", () => {
    const envelope = encryptSecret("tool-api-key");
    expect(decryptToolCredentialSecret(envelope)).toBe("tool-api-key");
  });

  test("passes a legacy/inference plaintext value through unchanged", () => {
    expect(decryptToolCredentialSecret("sk-plain-inference-key")).toBe(
      "sk-plain-inference-key",
    );
  });

  test("round-trip across encrypt-on-write -> decrypt-on-read for a real tool secret", () => {
    const stored = encryptSecret("linear-app-client-secret");
    // Simulates the write site (owner.ts) producing `stored`, and a read site
    // (task-credential.ts, tool-credentials.ts, etc.) resolving it back.
    expect(decryptToolCredentialSecret(stored)).toBe(
      "linear-app-client-secret",
    );
  });

  test("hardening: rejects forwarding a still-encrypted value that failed to decrypt cleanly", () => {
    // A pathological envelope-shaped string that is not a valid encryption
    // envelope (bad IV/tag) must fail loudly via decryptSecret rather than
    // silently pass the `v1:` prefixed garbage through as if it were usable.
    expect(() => decryptToolCredentialSecret("v1:bad:bad:bad")).toThrow();
  });
});
