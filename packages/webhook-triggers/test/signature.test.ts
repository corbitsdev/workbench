import { describe, expect, test } from "bun:test";
import {
  generateWebhookSecret,
  signPayload,
  verifySignature,
} from "../src/signature";

describe("generateWebhookSecret", () => {
  test("mints distinct high-entropy secrets", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});

describe("verifySignature", () => {
  const secret = generateWebhookSecret();
  const body = JSON.stringify({ hello: "world" });

  test("accepts a correctly signed payload", () => {
    const signature = signPayload(secret, body);
    expect(verifySignature(secret, body, signature)).toBe(true);
  });

  test("rejects a payload signed with a different secret", () => {
    const wrongSignature = signPayload(generateWebhookSecret(), body);
    expect(verifySignature(secret, body, wrongSignature)).toBe(false);
  });

  test("rejects a tampered body against the original signature", () => {
    const signature = signPayload(secret, body);
    const tamperedBody = JSON.stringify({ hello: "mallory" });
    expect(verifySignature(secret, tamperedBody, signature)).toBe(false);
  });

  test("rejects a missing signature header", () => {
    expect(verifySignature(secret, body, undefined)).toBe(false);
    expect(verifySignature(secret, body, "")).toBe(false);
  });

  test("rejects a non-hex signature without throwing", () => {
    expect(verifySignature(secret, body, "not-hex-at-all!!")).toBe(false);
  });

  test("rejects a well-formed-but-wrong-length hex signature", () => {
    expect(verifySignature(secret, body, "abcd")).toBe(false);
  });
});
