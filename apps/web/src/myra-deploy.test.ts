import { describe, expect, test } from "bun:test";

import { buildMyraDeployInput, MyraDeployError, packTarball } from "./myra-deploy";
import { MYRA_SOURCE_CONFIG } from "./myra-source";

describe("buildMyraDeployInput", () => {
  test("maps a published asset and the operator's offering pick to a WorkflowDeployInput", () => {
    const input = buildMyraDeployInput({
      assetId: "ast_123",
      sourceOfferingIds: ["off_1", "off_2"],
      defaultSourceOfferingId: "off_2",
    });

    expect(input).toEqual({
      source: {
        kind: "asset",
        assetId: "ast_123",
        package: { format: "tarball" },
      },
      entry: MYRA_SOURCE_CONFIG.entryPath,
      sourceOfferingIds: ["off_1", "off_2"],
      defaultSourceOfferingId: "off_2",
      pin: `${MYRA_SOURCE_CONFIG.packageName}@${MYRA_SOURCE_CONFIG.packageVersion}`,
    });
  });

  test("rejects an empty offering list", () => {
    expect(() =>
      buildMyraDeployInput({
        assetId: "ast_123",
        sourceOfferingIds: [],
        defaultSourceOfferingId: "off_1",
      }),
    ).toThrow(MyraDeployError);
  });

  test("rejects a default offering id absent from the offering list", () => {
    expect(() =>
      buildMyraDeployInput({
        assetId: "ast_123",
        sourceOfferingIds: ["off_1"],
        defaultSourceOfferingId: "off_2",
      }),
    ).toThrow(MyraDeployError);
  });
});

describe("packTarball", () => {
  test("writes USTAR headers whose checksum verifies and whose typeflag survives", async () => {
    const tarball = await packTarball({ "package.json": "{}" });
    const tar = new Uint8Array(
      await new Response(
        new Blob([tarball as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip")),
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
