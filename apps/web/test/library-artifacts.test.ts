import { describe, expect, test } from "bun:test";

import type { AssetRow } from "../src/api";
import {
  assetToArtifact,
  mapAssetsToArtifacts,
} from "../src/shell/library-artifacts";

const sample: AssetRow = {
  id: "ast_1",
  tenantId: "ten_1",
  kind: "workflow",
  name: "nightly-digest",
  displayName: "Nightly Digest",
  creatorPrincipalId: "pri_1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  origin: { tenantId: "ten_1", direct: true },
};

describe("library-artifacts", () => {
  test("prefers displayName for the artifact title", () => {
    expect(assetToArtifact(sample)).toEqual({
      id: "ast_1",
      title: "Nightly Digest",
      kind: "workflow",
      ownerName: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  test("falls back to the asset name when displayName is null", () => {
    const unnamed = { ...sample, displayName: null };
    expect(assetToArtifact(unnamed).title).toBe("nightly-digest");
  });

  test("maps a list without inventing or dropping rows", () => {
    const second = {
      ...sample,
      id: "ast_2",
      kind: "skill",
      name: "summarize",
      displayName: null,
    };
    const mapped = mapAssetsToArtifacts([sample, second]);
    expect(mapped).toHaveLength(2);
    expect(mapped[0]?.id).toBe("ast_1");
    expect(mapped[1]?.kind).toBe("skill");
  });
});
