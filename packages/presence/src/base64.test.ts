import { describe, expect, test } from "bun:test";
import { decodeBase64, encodeBase64, InvalidBase64Error } from "./base64";

describe("base64 codec", () => {
  test("round-trips arbitrary bytes, including lengths not divisible by 3", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 16, 257]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 37 + 11) % 256;
      expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
    }
  });

  test("matches a known vector", () => {
    const bytes = new TextEncoder().encode("Yjs update");
    expect(encodeBase64(bytes)).toBe("WWpzIHVwZGF0ZQ==");
    expect(decodeBase64("WWpzIHVwZGF0ZQ==")).toEqual(bytes);
  });

  test("rejects invalid characters rather than silently dropping them", () => {
    expect(() => decodeBase64("not-valid-base64!!")).toThrow(
      InvalidBase64Error,
    );
  });
});
