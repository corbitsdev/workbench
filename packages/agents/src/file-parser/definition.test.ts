import { describe, expect, it } from "bun:test";
import {
  FILE_PARSER_NAME,
  FILE_PARSER_CREDENTIAL_REQUIREMENTS,
  FILE_PARSER_MODEL_CONFIG,
} from "./definition";
import { AGENT_TEMPLATES } from "../templates";
import { canonicalizeToolNames } from "../tool-names";
import { PERSONAL_AGENT_BASE_TOOLS } from "../personal-agent/definition";

describe("File Parser agent definition (CL-2628)", () => {
  it("is bound to the Anthropic adapter (doc-capable) on claude-sonnet-5", () => {
    expect(FILE_PARSER_CREDENTIAL_REQUIREMENTS).toEqual([
      { providerName: "anthropic", source: "tenant", name: "anthropic-api" },
    ]);
    expect(FILE_PARSER_MODEL_CONFIG.defaultModel).toBe("claude-sonnet-5");
  });

  it("is registered as a non-deployable org template with no tools", () => {
    const template = AGENT_TEMPLATES.find((t) => t.name === FILE_PARSER_NAME);
    expect(template).toBeDefined();
    // Never surfaced in the user agent catalog — it runs only as an in-hub turn.
    expect(template!.deployable).toBe(false);
    expect(template!.capabilities.tools).toEqual([]);
    expect(template!.modelConfig).toEqual(FILE_PARSER_MODEL_CONFIG);
  });
});

describe("parse_file tool wiring (CL-2628)", () => {
  it("canonicalizes parse_file under the fileparser package factory id", () => {
    expect(canonicalizeToolNames(["parse_file"])).toEqual([
      "@workbench/tools-fileparser/fileparser:parse_file",
    ]);
  });

  it("grants parse_file to Myra via her base toolset", () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-fileparser/fileparser:parse_file",
    );
  });
});
