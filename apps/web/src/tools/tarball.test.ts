import { describe, expect, test } from "bun:test";

import { packTarball } from "./tarball";

describe("packTarball", () => {
  test("writes USTAR headers whose checksum verifies and whose typeflag survives", async () => {
    const tarball = await packTarball({ "package.json": "{}" });
    const tar = new Uint8Array(
      await new Response(
        new Blob([tarball as Uint8Array<ArrayBuffer>])
          .stream()
          .pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer(),
    );
    const header = tar.slice(0, 512);
    let expected = 0;
    for (let i = 0; i < 512; i++) expected += i >= 148 && i < 156 ? 0x20 : header[i]!;
    const stored = parseInt(new TextDecoder().decode(header.slice(148, 154)), 8);
    expect(stored).toBe(expected);
    expect(String.fromCharCode(header[156]!)).toBe("0");
  });
});
