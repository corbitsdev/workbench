/// <reference types="bun" />
// Runtime-validation tests for the arktype boundary schemas migrated in CL-1850.
// These pin that the exported schemas accept well-formed boundary payloads and
// reject malformed ones, so a drift in the request/response contract fails loudly.
import { describe, expect, it } from "bun:test";
import "./test-setup";
import { type } from "arktype";
import {
  ArtifactsPageSchema,
  SkillItemSchema,
  ClientOptionsSchema,
  CreateArtifactParamsSchema,
  CreateSkillParamsSchema,
  UpdateSkillParamsSchema,
  AttachSkillParamsSchema,
  ListArtifactsParamsSchema,
} from "./index";

const validArtifact = {
  id: "art-1",
  sessionId: null,
  parentId: null,
  painPointId: null,
  kind: "link",
  title: "Docs",
  content: "https://example.com",
  status: "draft",
  version: 1,
  ownerPrincipalId: "prn-1",
  createdAt: "2026-06-26T00:00:00.000Z",
  updatedAt: "2026-06-26T00:00:00.000Z",
  source: { origin: "imported" },
};

describe("ArtifactsPageSchema", () => {
  it("accepts a page of session-enriched artifacts with a null cursor", () => {
    const out = ArtifactsPageSchema({
      artifacts: [
        {
          ...validArtifact,
          sessionName: "Acme call",
          sessionStatus: "done",
          ownerName: "Sawyer",
        },
      ],
      nextCursor: null,
    });
    expect(out instanceof type.errors).toBe(false);
    if (!(out instanceof type.errors)) {
      expect(out.artifacts[0]?.sessionName).toBe("Acme call");
      expect(out.nextCursor).toBeNull();
    }
  });

  it("accepts the real hub row shape where session enrichment is all null", () => {
    // GET /artifacts emits sessionName/sessionStatus/ownerName as null for any
    // artifact not tied to a finished workbench session — the common case. The
    // schema must accept a null sessionStatus or listArtifacts throws on every
    // real page.
    const out = ArtifactsPageSchema({
      artifacts: [
        {
          ...validArtifact,
          sessionName: null,
          sessionStatus: null,
          ownerName: null,
        },
      ],
      nextCursor: null,
    });
    expect(out instanceof type.errors).toBe(false);
    if (!(out instanceof type.errors)) {
      expect(out.artifacts[0]?.sessionStatus).toBeNull();
    }
  });

  it("rejects a page whose artifact is missing the session enrichment fields", () => {
    const out = ArtifactsPageSchema({
      artifacts: [validArtifact],
      nextCursor: null,
    });
    expect(out instanceof type.errors).toBe(true);
  });

  it("rejects an unknown sessionStatus", () => {
    const out = ArtifactsPageSchema({
      artifacts: [
        {
          ...validArtifact,
          sessionName: null,
          sessionStatus: "exploded",
          ownerName: null,
        },
      ],
      nextCursor: null,
    });
    expect(out instanceof type.errors).toBe(true);
  });
});

describe("SkillItemSchema", () => {
  it("accepts a well-formed skill row", () => {
    const out = SkillItemSchema({
      id: "ast-1",
      name: "writer",
      displayName: null,
      createdAt: "2026-06-26T00:00:00.000Z",
      updatedAt: "2026-06-26T00:00:00.000Z",
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("rejects a skill row whose id is not a string", () => {
    const out = SkillItemSchema({
      id: 42,
      name: "writer",
      displayName: null,
      createdAt: "x",
      updatedAt: "y",
    });
    expect(out instanceof type.errors).toBe(true);
  });
});

describe("ClientOptionsSchema", () => {
  it("accepts an empty options object (all fields optional)", () => {
    expect(ClientOptionsSchema({}) instanceof type.errors).toBe(false);
  });

  it("accepts a baseUrl string", () => {
    expect(
      ClientOptionsSchema({ baseUrl: "http://localhost:4000" }) instanceof
        type.errors,
    ).toBe(false);
  });

  it("rejects a non-string baseUrl", () => {
    expect(ClientOptionsSchema({ baseUrl: 5 }) instanceof type.errors).toBe(
      true,
    );
  });
});

describe("request param schemas", () => {
  it("CreateArtifactParamsSchema requires mode/title/content and constrains mode", () => {
    expect(
      CreateArtifactParamsSchema({
        mode: "url",
        title: "T",
        content: "C",
      }) instanceof type.errors,
    ).toBe(false);
    expect(
      CreateArtifactParamsSchema({
        mode: "video",
        title: "T",
        content: "C",
      }) instanceof type.errors,
    ).toBe(true);
    expect(
      CreateArtifactParamsSchema({ title: "T", content: "C" }) instanceof
        type.errors,
    ).toBe(true);
  });

  it("CreateSkillParamsSchema requires name and text", () => {
    expect(
      CreateSkillParamsSchema({ name: "n", text: "t" }) instanceof type.errors,
    ).toBe(false);
    expect(CreateSkillParamsSchema({ name: "n" }) instanceof type.errors).toBe(
      true,
    );
  });

  it("UpdateSkillParamsSchema requires assetId and text", () => {
    expect(
      UpdateSkillParamsSchema({ assetId: "a", text: "t" }) instanceof
        type.errors,
    ).toBe(false);
    expect(UpdateSkillParamsSchema({ text: "t" }) instanceof type.errors).toBe(
      true,
    );
  });

  it("AttachSkillParamsSchema requires agentId and assetId", () => {
    expect(
      AttachSkillParamsSchema({ agentId: "ag", assetId: "as" }) instanceof
        type.errors,
    ).toBe(false);
    expect(
      AttachSkillParamsSchema({ agentId: "ag" }) instanceof type.errors,
    ).toBe(true);
  });

  it("ListArtifactsParamsSchema constrains sort to newest/oldest", () => {
    expect(
      ListArtifactsParamsSchema({ sort: "newest" }) instanceof type.errors,
    ).toBe(false);
    expect(
      ListArtifactsParamsSchema({ sort: "sideways" }) instanceof type.errors,
    ).toBe(true);
  });
});
