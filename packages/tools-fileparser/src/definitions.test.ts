import { describe, expect, it } from "bun:test";
import {
  PARSE_FILE_DEFINITION,
  FILEPARSER_TOOL_DEFINITIONS,
} from "./definitions";

describe("parse_file tool definition", () => {
  it("requires an artifactId and exposes an optional instructions param", () => {
    expect(PARSE_FILE_DEFINITION.name).toBe("parse_file");
    const schema = PARSE_FILE_DEFINITION.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual([
      "artifactId",
      "instructions",
    ]);
    expect(schema.required).toEqual(["artifactId"]);
  });

  it("is the only tool the package exports", () => {
    expect(FILEPARSER_TOOL_DEFINITIONS).toEqual([PARSE_FILE_DEFINITION]);
  });

  it("steers the model away from already-text content", () => {
    const description = PARSE_FILE_DEFINITION.description.toLowerCase();
    expect(description).toContain("pdf or image");
    expect(description).toContain("artifact_read");
  });
});
