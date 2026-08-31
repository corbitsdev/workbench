import { describe, expect, test } from "bun:test";
import {
  generateWebhookSecret,
  signPayload,
  verifySignature,
} from "../src/signature";

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

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

  test("accepts a correctly signed payload with a fresh timestamp", () => {
    const timestamp = nowSeconds();
    const signature = signPayload(secret, timestamp, body);
    expect(verifySignature(secret, timestamp, body, signature)).toBe(true);
  });

  test("rejects a payload signed with a different secret", () => {
    const timestamp = nowSeconds();
    const wrongSignature = signPayload(
      generateWebhookSecret(),
      timestamp,
      body,
    );
    expect(verifySignature(secret, timestamp, body, wrongSignature)).toBe(
      false,
    );
  });

  test("rejects a tampered body against the original signature", () => {
    const timestamp = nowSeconds();
    const signature = signPayload(secret, timestamp, body);
    const tamperedBody = JSON.stringify({ hello: "mallory" });
    expect(verifySignature(secret, timestamp, tamperedBody, signature)).toBe(
      false,
    );
  });

  test("rejects a missing signature header", () => {
    const timestamp = nowSeconds();
    expect(verifySignature(secret, timestamp, body, undefined)).toBe(false);
    expect(verifySignature(secret, timestamp, body, "")).toBe(false);
  });

  test("rejects a non-hex signature without throwing", () => {
    const timestamp = nowSeconds();
    expect(verifySignature(secret, timestamp, body, "not-hex-at-all!!")).toBe(
      false,
    );
  });

  test("rejects a well-formed-but-wrong-length hex signature", () => {
    const timestamp = nowSeconds();
    expect(verifySignature(secret, timestamp, body, "abcd")).toBe(false);
  });

  test("rejects a signature computed over a different timestamp than the one presented", () => {
    const timestamp = nowSeconds();
    const signature = signPayload(secret, timestamp, body);
    const laterTimestamp = String(Number(timestamp) + 1);
    expect(verifySignature(secret, laterTimestamp, body, signature)).toBe(
      false,
    );
  });

  test("rejects a replayed delivery once its timestamp is outside the tolerance window", () => {
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301);
    const signature = signPayload(secret, staleTimestamp, body);
    expect(verifySignature(secret, staleTimestamp, body, signature)).toBe(
      false,
    );
  });

  test("accepts a timestamp comfortably inside the tolerance window", () => {
    // 299s, not the exact 300s boundary: the boundary itself is racy
    // against wall-clock time elapsing between signing and verifying.
    const edgeTimestamp = String(Math.floor(Date.now() / 1000) - 299);
    const signature = signPayload(secret, edgeTimestamp, body);
    expect(verifySignature(secret, edgeTimestamp, body, signature)).toBe(true);
  });

  test("rejects a timestamp forged too far into the future", () => {
    const futureTimestamp = String(Math.floor(Date.now() / 1000) + 301);
    const signature = signPayload(secret, futureTimestamp, body);
    expect(verifySignature(secret, futureTimestamp, body, signature)).toBe(
      false,
    );
  });

  test("rejects a missing timestamp header", () => {
    const signature = signPayload(secret, nowSeconds(), body);
    expect(verifySignature(secret, undefined, body, signature)).toBe(false);
    expect(verifySignature(secret, "", body, signature)).toBe(false);
  });

  test("rejects a non-numeric timestamp header without treating it as fresh", () => {
    const signature = signPayload(secret, "not-a-number", body);
    expect(verifySignature(secret, "not-a-number", body, signature)).toBe(
      false,
    );
  });
});
