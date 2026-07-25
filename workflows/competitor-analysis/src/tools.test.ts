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

describe("competitor_analysis_format_report_document (CL-4232)", () => {
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
