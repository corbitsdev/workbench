import { describe, expect, test } from "bun:test";
import { hubToolEntriesFromDefinitions } from "./index";

describe("hubToolEntriesFromDefinitions", () => {
  test("keys entries by definition.name and carries the definition through", () => {
    const definition = { name: "example_tool", description: "does a thing" };
    const entries = hubToolEntriesFromDefinitions([definition], {
      example_tool: "read",
    });
    expect(Object.keys(entries)).toEqual(["example_tool"]);
    expect(entries.example_tool?.sideEffect).toBe("read");
    expect(entries.example_tool?.definition).toBe(definition);
  });

  test("throws loudly when a runtime definition has no declared side effect", () => {
    const definitions = [{ name: "undeclared_tool" }];
    expect(() => hubToolEntriesFromDefinitions(definitions, {})).toThrow(
      'no side effect declared for tool "undeclared_tool"',
    );
  });
});
