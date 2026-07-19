/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import type { ArtifactWithVersions } from "./types";
import {
  ArtifactVisualSchema,
  GalleryArtifactSchema,
  parseGalleryArtifact,
} from "./types";
import { visualForKind } from "./artifact-visuals";

describe("ArtifactWithVersions type export (CL-1552)", () => {
  it("ArtifactWithVersions is exported from @workbench/artifact types", () => {
    const artifact: ArtifactWithVersions = {
      id: "a-1",
      parentId: null,
      kind: "email",
      title: "Test",
      content: "Body",
      status: "draft",
      version: 1,
      ownerPrincipalId: null,
      archivedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: { origin: "workflow" },
      versions: [],
    };
    expect(artifact.id).toBe("a-1");
    expect(Array.isArray(artifact.versions)).toBe(true);
  });

  it("ArtifactWithVersions versions array holds ArtifactVersion shape", () => {
    const artifact: ArtifactWithVersions = {
      id: "a-1",
      parentId: null,
      kind: "email",
      title: "Test",
      content: "Body",
      status: "draft",
      version: 2,
      ownerPrincipalId: null,
      archivedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: { origin: "workflow" },
      versions: [
        {
          id: "av-1",
          artifactId: "a-1",
          version: 1,
          title: "v1 title",
          content: "v1 body",
          authorId: "usr-1",
          createdAt: new Date().toISOString(),
        },
      ],
    };
    expect(artifact.versions).toHaveLength(1);
    expect(artifact.versions[0]!.version).toBe(1);
  });
});

describe("ArtifactVisualSchema", () => {
  it("accepts a valid visual", () => {
    const result = ArtifactVisualSchema({
      label: "Email",
      fill: "bg-orange",
      span: "row-span-3",
    });
    expect(result instanceof type.errors).toBe(false);
    if (!(result instanceof type.errors)) {
      expect(result.label).toBe("Email");
    }
  });

  it("span accepts any string value", () => {
    const result = ArtifactVisualSchema({
      label: "X",
      fill: "bg-x",
      span: "completely-arbitrary-value",
    });
    expect(result instanceof type.errors).toBe(false);
  });

  it("rejects missing required fields", () => {
    const result = ArtifactVisualSchema({ label: "X" });
    expect(result instanceof type.errors).toBe(true);
  });
});

describe("GalleryArtifactSchema", () => {
  const valid = {
    label: "Email",
    fill: "bg-orange",
    span: "row-span-3",
    id: "a-1",
    title: "My Email",
    kind: "email",
    from: "Acme Corp",
    time: "2 days ago",
    provenance: "Workflow",
    status: "draft" as const,
  };

  it("accepts a fully valid GalleryArtifact", () => {
    const result = GalleryArtifactSchema(valid);
    expect(result instanceof type.errors).toBe(false);
    if (!(result instanceof type.errors)) {
      expect(result.id).toBe("a-1");
      expect(result.from).toBe("Acme Corp");
    }
  });

  it("rejects a record missing required fields", () => {
    const result = GalleryArtifactSchema({ label: "X" });
    expect(result instanceof type.errors).toBe(true);
  });

  it("accepts empty-string time (formatRelativeTime overflow path)", () => {
    const result = GalleryArtifactSchema({ ...valid, time: "" });
    expect(result instanceof type.errors).toBe(false);
    if (!(result instanceof type.errors)) {
      expect(result.time).toBe("");
    }
  });
});

describe("parseGalleryArtifact", () => {
  it("returns a GalleryArtifact for valid input", () => {
    const artifact = parseGalleryArtifact({
      label: "Tweet",
      fill: "bg-blue",
      span: "row-span-2",
      id: "a-2",
      title: "A Tweet",
      kind: "twitter-post",
      from: "Startup",
      time: "just now",
      provenance: "Agent",
      status: "approved",
    });
    expect(artifact.id).toBe("a-2");
  });

  it("throws for invalid input", () => {
    expect(() => parseGalleryArtifact({ id: 42 })).toThrow("GalleryArtifact:");
  });
});

describe("visualForKind sanity", () => {
  it("returns a visual for email", () => {
    const v = visualForKind("email");
    expect(v.label).toBeDefined();
  });
});
