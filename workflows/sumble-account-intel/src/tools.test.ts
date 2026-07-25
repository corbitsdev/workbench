import { describe, expect, test } from "bun:test";
import { createSumbleAccountIntelTools } from "./tools";
import { toolManifestFile } from "./tool-manifest";

const SIGNAL = new AbortController().signal;

function fullTool(name: string) {
  const tool = createSumbleAccountIntelTools().find(
    (t) => t.definition.name === name,
  );
  if (!tool || tool.kind !== "full") {
    throw new Error(`${name} not registered as a full tool`);
  }
  return tool.handler;
}

describe("sumble_account_intel_format_report_document (CL-4232)", () => {
  test("pairs organizationDomain and reply into a title/body document", async () => {
    const handler = fullTool("sumble_account_intel_format_report_document");
    const result = await handler(
      {
        id: "document",
        name: "sumble_account_intel_format_report_document",
        arguments: {
          organizationDomain: "acme.com",
          reply: "## Account brief\n\nAcme is worth a look.",
        },
      },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    expect(result.content).toEqual({
      title: "acme.com",
      body: "## Account brief\n\nAcme is worth a look.",
    });
  });

  test("returns isError when reply is missing", async () => {
    const handler = fullTool("sumble_account_intel_format_report_document");
    const result = await handler(
      {
        id: "document",
        name: "sumble_account_intel_format_report_document",
        arguments: { organizationDomain: "acme.com" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("reply is required");
  });

  test("returns isError when organizationDomain is missing", async () => {
    const handler = fullTool("sumble_account_intel_format_report_document");
    const result = await handler(
      {
        id: "document",
        name: "sumble_account_intel_format_report_document",
        arguments: { reply: "body" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("organizationDomain is required");
  });
});

describe("tool-manifest completeness", () => {
  test("every registered tool name is declared in the hand-authored manifest", () => {
    const runtimeNames = createSumbleAccountIntelTools()
      .map((tool) => tool.definition.name)
      .sort();
    const factory = toolManifestFile.factories[0];
    if (!factory) {
      throw new Error(
        "expected the sumble-account-intel manifest to declare a factory",
      );
    }
    const manifestNames = [...factory.bareToolNames].sort();
    expect(manifestNames).toEqual(runtimeNames);
  });
});
