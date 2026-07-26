import { describe, expect, test } from "bun:test";
import { createCompetitorAnalysisTools } from "./tools";
import { toolManifestFile } from "./tool-manifest";

const SIGNAL = new AbortController().signal;

function fullTool(name: string) {
  const tool = createCompetitorAnalysisTools().find(
    (t) => t.definition.name === name,
  );
  if (!tool || tool.kind !== "full") {
    throw new Error(`${name} not registered as a full tool`);
  }
  return tool.handler;
}

describe("competitor_analysis_format_report_document", () => {
  test("pairs url and reply into a title/body document", async () => {
    const handler = fullTool("competitor_analysis_format_report_document");
    const result = await handler(
      {
        id: "document",
        name: "competitor_analysis_format_report_document",
        arguments: {
          url: "https://acme.com",
          reply: "## Competitor report\n\nAcme has three main rivals.",
        },
      },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    expect(result.content).toEqual({
      title: "https://acme.com",
      body: "## Competitor report\n\nAcme has three main rivals.",
    });
  });

  test("returns isError when reply is missing", async () => {
    const handler = fullTool("competitor_analysis_format_report_document");
    const result = await handler(
      {
        id: "document",
        name: "competitor_analysis_format_report_document",
        arguments: { url: "https://acme.com" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("reply is required");
  });

  test("returns isError when url is missing", async () => {
    const handler = fullTool("competitor_analysis_format_report_document");
    const result = await handler(
      {
        id: "document",
        name: "competitor_analysis_format_report_document",
        arguments: { reply: "body" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("url is required");
  });
});

describe("competitor_analysis_build_review_gate", () => {
  test("builds a choice block embedding the decoded report's title/content", async () => {
    const handler = fullTool("competitor_analysis_build_review_gate");
    const reply = JSON.stringify({
      title: "Acme — competitor analysis",
      content: "## Subject\nAcme sells CRM.",
      competitors: [],
    });
    const result = await handler(
      {
        id: "reviewGate",
        name: "competitor_analysis_build_review_gate",
        arguments: { reply },
      },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({
      kind: "choice",
      prompt: "Acme — competitor analysis\n\n## Subject\nAcme sells CRM.",
      options: [
        { id: "approve", label: "Approve & save", payload: { approved: true } },
        { id: "reject", label: "Reject", payload: { approved: false } },
      ],
    });
  });

  test("still renders the choice, never fails, when the reply is not decodable", async () => {
    const handler = fullTool("competitor_analysis_build_review_gate");
    const result = await handler(
      {
        id: "reviewGate",
        name: "competitor_analysis_build_review_gate",
        arguments: { reply: "not json" },
      },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    expect(result.isError).toBeUndefined();
    const content = result.content as { kind: string; options: unknown[] };
    expect(content.kind).toBe("choice");
    expect(content.options.length).toBe(2);
  });

  test("returns isError when reply is missing", async () => {
    const handler = fullTool("competitor_analysis_build_review_gate");
    const result = await handler(
      {
        id: "reviewGate",
        name: "competitor_analysis_build_review_gate",
        arguments: {},
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("reply is required");
  });
});

describe("tool-manifest completeness", () => {
  test("every registered tool name is declared in the hand-authored manifest", () => {
    const runtimeNames = createCompetitorAnalysisTools()
      .map((tool) => tool.definition.name)
      .sort();
    const factory = toolManifestFile.factories[0];
    if (!factory) {
      throw new Error(
        "expected the competitor-analysis manifest to declare a factory",
      );
    }
    const manifestNames = [...factory.bareToolNames].sort();
    expect(manifestNames).toEqual(runtimeNames);
  });
});
