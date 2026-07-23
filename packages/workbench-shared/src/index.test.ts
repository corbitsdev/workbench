import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  AnalyzeRequestSchema,
  AnalyzeResponseSchema,
  Artifact,
  GammaPresentationContentSchema,
  GenerateRequestSchema,
  GenerateResponseSchema,
  ImproveRequestSchema,
  ImproveResponseSchema,
  TranscriptInputSchema,
  WorkbenchSessionSchema,
  WorkflowStateSchema,
  WorkflowSummarySchema,
} from "./index";

const isErr = (v: unknown): boolean => v instanceof type.errors;

describe("Artifact schema carries the archive marker", () => {
  const base = {
    id: "art-1",
    parentId: null,
    kind: "document",
    title: "T",
    content: "C",
    version: 1,
    ownerPrincipalId: null,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
    source: { origin: "manual" },
  };

  test("accepts a null archivedAt (visible artifact)", () => {
    expect(isErr(Artifact({ ...base, archivedAt: null }))).toBe(false);
  });

  test("accepts an ISO archivedAt (archived artifact)", () => {
    const parsed = Artifact({
      ...base,
      archivedAt: "2026-07-09T12:00:00.000Z",
    });
    expect(isErr(parsed)).toBe(false);
    expect((parsed as { archivedAt: string | null }).archivedAt).toBe(
      "2026-07-09T12:00:00.000Z",
    );
  });

  test("rejects a payload missing archivedAt entirely", () => {
    expect(isErr(Artifact(base))).toBe(true);
  });
});

describe("GammaPresentationContentSchema", () => {
  test("accepts structured deck content and rejects a bare URL string", () => {
    const ok = GammaPresentationContentSchema({
      url: "https://gamma.app/docs/Building-abc",
      description: "A deck about building on Interchange",
      gammaId: "abc",
    });
    expect(isErr(ok)).toBe(false);
    expect(
      isErr(GammaPresentationContentSchema("https://gamma.app/docs/abc")),
    ).toBe(true);
    expect(
      isErr(
        GammaPresentationContentSchema({
          url: "https://gamma.app/docs/abc",
          gammaId: "abc",
        }),
      ),
    ).toBe(true);
  });
});

describe("WorkflowSummarySchema", () => {
  test("accepts a well-formed summary", () => {
    const ok = WorkflowSummarySchema({
      id: "wf_1",
      kind: "mvt",
      status: "running",
      createdAt: "2026-06-28T00:00:00Z",
    });
    expect(isErr(ok)).toBe(false);
  });

  test("rejects a missing required field", () => {
    const bad = WorkflowSummarySchema({ id: "wf_1", kind: "mvt" });
    expect(isErr(bad)).toBe(true);
  });

  test("rejects a wrong-typed field", () => {
    const bad = WorkflowSummarySchema({
      id: "wf_1",
      kind: "mvt",
      status: 5,
      createdAt: "x",
    });
    expect(isErr(bad)).toBe(true);
  });
});

describe("TranscriptInputSchema", () => {
  test("accepts transcript with no source", () => {
    expect(isErr(TranscriptInputSchema({ transcript: "hi" }))).toBe(false);
  });

  test("accepts a known source", () => {
    expect(
      isErr(TranscriptInputSchema({ transcript: "hi", source: "granola" })),
    ).toBe(false);
  });

  test("rejects an unknown source", () => {
    expect(
      isErr(TranscriptInputSchema({ transcript: "hi", source: "fax" })),
    ).toBe(true);
  });
});

describe("WorkbenchSessionSchema", () => {
  test("accepts a session with null companyName", () => {
    const ok = WorkbenchSessionSchema({
      id: "ses_1",
      transcriptId: "tr_1",
      status: "ready",
      companyName: null,
      createdAt: "a",
      updatedAt: "b",
    });
    expect(isErr(ok)).toBe(false);
  });

  test("rejects an invalid status", () => {
    const bad = WorkbenchSessionSchema({
      id: "ses_1",
      transcriptId: "tr_1",
      status: "exploding",
      companyName: null,
      createdAt: "a",
      updatedAt: "b",
    });
    expect(isErr(bad)).toBe(true);
  });
});

describe("WorkflowStateSchema", () => {
  test("accepts a state with an open steps map", () => {
    const ok = WorkflowStateSchema({
      id: "wf_1",
      kind: "mvt",
      status: "analyzing",
      currentStep: "draft",
      companyName: "Acme",
      steps: { draft: { foo: 1 } },
    });
    expect(isErr(ok)).toBe(false);
  });

  test("rejects a non-object steps", () => {
    const bad = WorkflowStateSchema({
      id: "wf_1",
      kind: "mvt",
      status: "analyzing",
      currentStep: "draft",
      companyName: null,
      steps: "nope",
    });
    expect(isErr(bad)).toBe(true);
  });
});

describe("AnalyzeRequestSchema / AnalyzeResponseSchema", () => {
  test("request accepts a transcript", () => {
    expect(isErr(AnalyzeRequestSchema({ transcript: "t" }))).toBe(false);
  });

  test("request rejects a missing transcript", () => {
    expect(isErr(AnalyzeRequestSchema({}))).toBe(true);
  });

  test("response accepts nested pain points", () => {
    const ok = AnalyzeResponseSchema({
      workflowId: "wf_1",
      painPoints: [
        {
          id: "pp_1",
          workflowId: "wf_1",
          severity: "high",
          context: "c",
          quote: "q",
          selected: false,
          createdAt: "a",
        },
      ],
      status: "ready",
    });
    expect(isErr(ok)).toBe(false);
  });

  test("response rejects a bad nested pain point severity", () => {
    const bad = AnalyzeResponseSchema({
      workflowId: "wf_1",
      painPoints: [
        {
          id: "pp_1",
          workflowId: "wf_1",
          severity: "apocalyptic",
          context: "c",
          quote: "q",
          selected: false,
          createdAt: "a",
        },
      ],
      status: "ready",
    });
    expect(isErr(bad)).toBe(true);
  });
});

describe("GenerateRequestSchema / GenerateResponseSchema", () => {
  test("request accepts pain-point ids", () => {
    expect(
      isErr(
        GenerateRequestSchema({ workflowId: "wf_1", painPointIds: ["pp_1"] }),
      ),
    ).toBe(false);
  });

  test("request rejects non-string-array painPointIds", () => {
    expect(
      isErr(GenerateRequestSchema({ workflowId: "wf_1", painPointIds: [1] })),
    ).toBe(true);
  });

  test("response rejects a malformed nested artifact", () => {
    const bad = GenerateResponseSchema({
      workflowId: "wf_1",
      artifacts: [{ id: "a_1" }],
      status: "done",
    });
    expect(isErr(bad)).toBe(true);
  });
});

describe("ImproveRequestSchema / ImproveResponseSchema", () => {
  test("request accepts an artifactId and feedback", () => {
    expect(
      isErr(ImproveRequestSchema({ artifactId: "a_1", feedback: "more pep" })),
    ).toBe(false);
  });

  test("request rejects a missing feedback", () => {
    expect(isErr(ImproveRequestSchema({ artifactId: "a_1" }))).toBe(true);
  });

  test("response rejects a non-object artifact", () => {
    expect(
      isErr(ImproveResponseSchema({ artifact: "nope", status: "done" })),
    ).toBe(true);
  });
});
