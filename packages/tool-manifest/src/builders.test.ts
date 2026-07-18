import { describe, expect, test } from "bun:test";
import { hubToolEntriesFromDefinitions } from "./index";

describe("hubToolEntriesFromDefinitions", () => {
  test("keys entries by definition.name and carries the definition and its inline side effect through", () => {
    const definition = {
      name: "example_tool",
      description: "does a thing",
      sideEffect: "read" as const,
    };
    const entries = hubToolEntriesFromDefinitions([definition]);
    expect(Object.keys(entries)).toEqual(["example_tool"]);
    expect(entries.example_tool?.sideEffect).toBe("read");
    expect(entries.example_tool?.definition).toBe(definition);
  });

  test("carries a write classification through unchanged", () => {
    const definition = {
      name: "example_write_tool",
      sideEffect: "write" as const,
    };
    const entries = hubToolEntriesFromDefinitions([definition]);
    expect(entries.example_write_tool?.sideEffect).toBe("write");
  });
});
