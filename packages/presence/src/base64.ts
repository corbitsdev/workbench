// A tiny, dependency-free base64 codec used to carry Yjs binary updates
// over the package's plain-JSON wire format (see `schema.ts`'s note on why
// the boundary stays JSON). Written by hand rather than reached for
// `Buffer` or `btoa`/`atob`: this module is shared between server route
// handlers and `client.ts`, and neither `Buffer` (no DOM) nor `btoa` (no
// Node global) is guaranteed on both sides — a manual codec working
// directly on `Uint8Array` needs neither.
const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBase64(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const chunk = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    result += BASE64_CHARS[(chunk >> 18) & 0x3f];
    result += BASE64_CHARS[(chunk >> 12) & 0x3f];
    result += b1 === undefined ? "=" : BASE64_CHARS[(chunk >> 6) & 0x3f];
    result += b2 === undefined ? "=" : BASE64_CHARS[chunk & 0x3f];
  }
  return result;
}

const BASE64_LOOKUP = ((): Uint8Array => {
  const table = new Uint8Array(256).fill(0xff);
  for (let i = 0; i < BASE64_CHARS.length; i += 1) {
    table[BASE64_CHARS.charCodeAt(i)] = i;
  }
  return table;
})();

export class InvalidBase64Error extends Error {}

export function decodeBase64(input: string): Uint8Array {
  const clean = input.replace(/=+$/, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const value = BASE64_LOOKUP[ch.charCodeAt(0)];
    if (value === undefined || value === 0xff) {
      throw new InvalidBase64Error(`Invalid base64 character: ${ch}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}
