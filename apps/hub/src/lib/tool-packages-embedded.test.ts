import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import {
  EmbeddedToolPackageManifestSchema,
  classifyToolPackageDrift,
  embeddedToolPackagesDir,
  integrityFromTarballBytes,
} from "./tool-packages-embedded";

describe("tool-packages-embedded", () => {
  it("validates the committed manifest schema", async () => {
    const raw = await readFile(
      join(embeddedToolPackagesDir(), "manifest.json"),
      "utf8",
    );
    const parsed = EmbeddedToolPackageManifestSchema(JSON.parse(raw));
    expect(parsed instanceof type.errors).toBe(false);
  });

  it("integrityFromTarballBytes matches ssri sha512 for fixture bytes", () => {
    const fixture = new TextEncoder().encode("fixture-tarball-bytes");
    const integrity = integrityFromTarballBytes(fixture);
    expect(integrity).toMatch(/^sha512-/);
    expect(integrityFromTarballBytes(fixture)).toBe(integrity);
  });

  it("classifyToolPackageDrift: missing registry blob", () => {
    expect(
      classifyToolPackageDrift({
        embeddedIntegrity: "sha512-abc",
        registryBytes: null,
      }),
    ).toEqual({ action: "upload", reason: "missing" });
  });

  it("classifyToolPackageDrift: integrity mismatch", () => {
    const bytes = Buffer.from("other-content");
    const embedded = integrityFromTarballBytes(Buffer.from("embedded-content"));
    expect(
      classifyToolPackageDrift({
        embeddedIntegrity: embedded,
        registryBytes: bytes,
      }),
    ).toEqual({ action: "upload", reason: "integrity_mismatch" });
  });

  it("classifyToolPackageDrift: up to date", () => {
    const bytes = Buffer.from("same-bytes");
    const embedded = integrityFromTarballBytes(bytes);
    expect(
      classifyToolPackageDrift({
        embeddedIntegrity: embedded,
        registryBytes: bytes,
      }),
    ).toEqual({ action: "skip", reason: "up_to_date" });
  });
});
