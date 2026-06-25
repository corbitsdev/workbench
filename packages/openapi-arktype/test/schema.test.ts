import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { convertSchema } from "../src/parse/schema.js";
import type { Diagnostic } from "../src/types.js";

function convert(schema: Record<string, unknown>) {
  const diagnostics: Diagnostic[] = [];
  const entry = convertSchema(schema, diagnostics);
  return { entry, diagnostics };
}

describe("convertSchema", () => {
  it("converts a simple string schema", () => {
    const { entry } = convert({ type: "string" });
    expect(entry.validator("hello")).toBe("hello");
    expect(entry.validator(123) instanceof type.errors).toBe(true);
  });

  it("converts an integer schema", () => {
    const { entry } = convert({ type: "integer" });
    expect(entry.validator(42)).toBe(42);
    expect(entry.validator(3.14) instanceof type.errors).toBe(true);
    expect(entry.validator("foo") instanceof type.errors).toBe(true);
  });

  it("converts an object with required and optional fields", () => {
    const { entry } = convert({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
      },
      required: ["name"],
    });

    expect(entry.validator({ name: "Alice", age: 30 })).toEqual({
      name: "Alice",
      age: 30,
    });
    expect(entry.validator({ name: "Bob" })).toEqual({ name: "Bob" });
    expect(entry.validator({}) instanceof type.errors).toBe(true);
  });

  it("converts an array schema", () => {
    const { entry } = convert({
      type: "array",
      items: { type: "string" },
    });

    expect(entry.validator(["a", "b"])).toEqual(["a", "b"]);
    expect(entry.validator([1]) instanceof type.errors).toBe(true);
  });

  it("converts enum values", () => {
    const { entry } = convert({
      type: "string",
      enum: ["red", "green", "blue"],
    });

    expect(entry.validator("red")).toBe("red");
    expect(entry.validator("yellow") instanceof type.errors).toBe(true);
  });

  it("converts string with minLength and maxLength", () => {
    const { entry } = convert({
      type: "string",
      minLength: 2,
      maxLength: 5,
    });

    expect(entry.validator("abc")).toBe("abc");
    expect(entry.validator("a") instanceof type.errors).toBe(true);
    expect(entry.validator("abcdef") instanceof type.errors).toBe(true);
  });

  it("converts number with min and max", () => {
    const { entry } = convert({
      type: "number",
      minimum: 0,
      maximum: 100,
    });

    expect(entry.validator(50)).toBe(50);
    expect(entry.validator(-1) instanceof type.errors).toBe(true);
    expect(entry.validator(101) instanceof type.errors).toBe(true);
  });

  it("applies email format as intersection", () => {
    const { entry, diagnostics } = convert({
      type: "string",
      format: "email",
    });

    expect(entry.validator("user@example.com")).toBe("user@example.com");
    expect(entry.validator("not-an-email") instanceof type.errors).toBe(true);
    expect(diagnostics.filter((d) => d.code === "UNSUPPORTED_FORMAT")).toEqual(
      [],
    );
  });

  it("applies uuid format", () => {
    const { entry } = convert({
      type: "string",
      format: "uuid",
    });

    expect(entry.validator("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(entry.validator("not-a-uuid") instanceof type.errors).toBe(true);
  });

  it("warns on unknown format", () => {
    const { entry, diagnostics } = convert({
      type: "string",
      format: "custom-thing",
    });

    // Still validates as string
    expect(entry.validator("anything")).toBe("anything");
    expect(diagnostics.some((d) => d.code === "UNSUPPORTED_FORMAT")).toBe(true);
  });

  it("strips metadata keys without affecting validation", () => {
    const { entry } = convert({
      type: "string",
      title: "A Title",
      description: "Some description",
      readOnly: true,
      default: "foo",
      example: "bar",
    });

    expect(entry.validator("hello")).toBe("hello");
    expect(entry.metadata.readOnly).toBe(true);
    expect(entry.metadata.default).toBe("foo");
    expect(entry.metadata.example).toBe("bar");
  });

  it("strips discriminator with diagnostic", () => {
    const { entry, diagnostics } = convert({
      oneOf: [
        {
          type: "object",
          properties: { kind: { const: "a" } },
          required: ["kind"],
        },
        {
          type: "object",
          properties: { kind: { const: "b" } },
          required: ["kind"],
        },
      ],
      discriminator: { propertyName: "kind" },
    });

    expect(entry.validator({ kind: "a" })).toEqual({ kind: "a" });
    expect(diagnostics.some((d) => d.code === "STRIPPED_DISCRIMINATOR")).toBe(
      true,
    );
  });

  it("preserves x- extensions in metadata", () => {
    const { entry } = convert({
      type: "string",
      "x-custom": "value",
      "x-another": 42,
    });

    expect(entry.metadata.extensions["x-custom"]).toBe("value");
    expect(entry.metadata.extensions["x-another"]).toBe(42);
  });

  it("handles allOf composition", () => {
    const { entry } = convert({
      allOf: [
        {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        {
          type: "object",
          properties: { age: { type: "integer" } },
          required: ["age"],
        },
      ],
    });

    expect(entry.validator({ name: "Alice", age: 30 })).toEqual({
      name: "Alice",
      age: 30,
    });
    expect(entry.validator({ name: "Alice" }) instanceof type.errors).toBe(
      true,
    );
  });

  it("handles type array for nullable (3.1 style)", () => {
    const { entry } = convert({
      type: ["string", "null"],
    });

    expect(entry.validator("hello")).toBe("hello");
    expect(entry.validator(null)).toBe(null);
    expect(entry.validator(123) instanceof type.errors).toBe(true);
  });

  it("falls back gracefully on conversion error", () => {
    const { entry, diagnostics } = convert({
      // intentionally invalid — no type, no composition, no enum
      minLength: 5,
    } as Record<string, unknown>);

    expect(diagnostics.some((d) => d.code === "SCHEMA_CONVERSION_ERROR")).toBe(
      true,
    );
    // Falls back to type.unknown — accepts anything
    expect(entry.validator("anything")).toBe("anything");
  });
});
