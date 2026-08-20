import { afterEach, describe, expect, test } from "bun:test";

import { UnauthenticatedError } from "@corbits/api-query";
import {
  artifactListRowToSummary,
  isArtifactsUnavailableStatus,
  mapArtifactListToSummaries,
  uploadArtifactFiles,
  type ArtifactListRow,
} from "../src/shell/library-artifacts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const sample: ArtifactListRow = {
  id: "art_1",
  kind: "file",
  title: "Quarterly report.pdf",
  ownerName: "Ada",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("library-artifacts", () => {
  test("maps list rows onto ArtifactSummary without inventing fields", () => {
    expect(artifactListRowToSummary(sample)).toEqual({
      id: "art_1",
      title: "Quarterly report.pdf",
      kind: "file",
      ownerName: "Ada",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  test("maps a list without inventing or dropping rows", () => {
    const second: ArtifactListRow = {
      ...sample,
      id: "art_2",
      kind: "document",
      title: "notes.txt",
      ownerName: null,
    };
    const mapped = mapArtifactListToSummaries([sample, second]);
    expect(mapped).toHaveLength(2);
    expect(mapped[0]?.id).toBe("art_1");
    expect(mapped[1]?.kind).toBe("document");
    expect(mapped[1]?.ownerName).toBeNull();
  });

  test("detects the unconfigured-plane status", () => {
    expect(isArtifactsUnavailableStatus(503)).toBe(true);
    expect(isArtifactsUnavailableStatus(500)).toBe(false);
    expect(isArtifactsUnavailableStatus(undefined)).toBe(false);
  });

  test("uploadArtifactFiles throws an UnauthenticatedError on 401", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 401 }))) as typeof fetch;
    await expect(
      uploadArtifactFiles("tnt_1", [new File(["x"], "x.txt")]),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});
