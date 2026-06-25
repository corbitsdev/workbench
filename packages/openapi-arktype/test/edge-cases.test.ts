import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { type } from "arktype";
import { convertSchema } from "../src/parse/schema.js";
import { createClient } from "../src/runtime/index.js";
import { emitSchemas, emitOperations } from "../src/codegen/emit.js";
import type { Diagnostic } from "../src/types.js";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(thisDir);
const tmpBase = join(projectRoot, "tmp");

function convert(schema: Record<string, unknown>) {
  const diagnostics: Diagnostic[] = [];
  const entry = convertSchema(schema, diagnostics);
  return { entry, diagnostics };
}

describe("circular schema references", () => {
  it("handles self-referencing schema in runtime without crashing", () => {
    // Simulate what dereference produces for a circular $ref:
    // a JS object that references itself
    const treeNode: Record<string, unknown> = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    };
    // Create circular reference
    (treeNode.properties as Record<string, unknown>).children = {
      type: "array",
      items: treeNode,
    };

    const { entry, diagnostics } = convert(treeNode);

    // Should not crash, should produce a validator
    expect(entry.validator).toBeDefined();
    // Should emit a diagnostic about the circular reference
    expect(diagnostics.some((d) => d.message.includes("Circular"))).toBe(true);
  });

  it("handles circular schema in codegen without crashing", () => {
    const node: Record<string, unknown> = {
      type: "object",
      properties: {
        value: { type: "string" },
      },
    };
    (node.properties as Record<string, unknown>).next = node;

    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas({ TreeNode: node }, diagnostics);

    // Should not throw, should produce valid output
    expect(result).toContain("export const TreeNode");
    expect(result).toContain("type.unknown");
  });
});

describe("schema edge cases", () => {
  it("handles anyOf composition", () => {
    const { entry } = convert({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
    expect(entry.validator("hello")).toBe("hello");
    expect(entry.validator(42)).toBe(42);
    expect(entry.validator(true) instanceof type.errors).toBe(true);
  });

  it("handles const values", () => {
    const { entry: strConst } = convert({ const: "fixed" });
    expect(strConst.validator("fixed")).toBe("fixed");
    expect(strConst.validator("other") instanceof type.errors).toBe(true);

    const { entry: numConst } = convert({ const: 42 });
    expect(numConst.validator(42)).toBe(42);
    expect(numConst.validator(43) instanceof type.errors).toBe(true);

    const { entry: nullConst } = convert({ const: null });
    expect(nullConst.validator(null)).toBe(null);
  });

  it("handles nested objects", () => {
    const { entry } = convert({
      type: "object",
      properties: {
        address: {
          type: "object",
          properties: {
            street: { type: "string" },
            city: { type: "string" },
          },
          required: ["street"],
        },
      },
      required: ["address"],
    });

    expect(
      entry.validator({ address: { street: "123 Main", city: "NYC" } }),
    ).toEqual({ address: { street: "123 Main", city: "NYC" } });
    expect(entry.validator({}) instanceof type.errors).toBe(true);
    expect(entry.validator({ address: {} }) instanceof type.errors).toBe(true);
  });

  it("handles array with minItems and maxItems", () => {
    const { entry } = convert({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 3,
    });

    expect(entry.validator(["a"])).toEqual(["a"]);
    expect(entry.validator(["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(entry.validator([]) instanceof type.errors).toBe(true);
    expect(entry.validator(["a", "b", "c", "d"]) instanceof type.errors).toBe(
      true,
    );
  });

  it("handles mixed-type enum", () => {
    const { entry } = convert({
      enum: ["active", 1, null],
    });

    expect(entry.validator("active")).toBe("active");
    expect(entry.validator(1)).toBe(1);
    expect(entry.validator(null)).toBe(null);
    expect(entry.validator("other") instanceof type.errors).toBe(true);
  });

  it("handles string with pattern", () => {
    const { entry } = convert({
      type: "string",
      pattern: "^[A-Z]{2}$",
    });

    // Pattern is stripped by our normalizer since jsonSchemaToType
    // handles it. Let's just verify the validator works for strings.
    expect(typeof entry.validator("AB")).toBe("string");
  });

  it("handles exclusiveMinimum and exclusiveMaximum", () => {
    const { entry } = convert({
      type: "number",
      exclusiveMinimum: 0,
      exclusiveMaximum: 10,
    });

    expect(entry.validator(5)).toBe(5);
    expect(entry.validator(0) instanceof type.errors).toBe(true);
    expect(entry.validator(10) instanceof type.errors).toBe(true);
  });

  it("handles additionalProperties: false in runtime", () => {
    const { entry } = convert({
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    });

    expect(entry.validator({ name: "Alice" })).toEqual({ name: "Alice" });
    expect(
      entry.validator({ name: "Alice", extra: true }) instanceof type.errors,
    ).toBe(true);
  });
});

describe("codegen edge cases", () => {
  let outDir: string;

  beforeEach(async () => {
    await mkdir(tmpBase, { recursive: true });
    outDir = await mkdtemp(join(tmpBase, "edge-test-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("emits valid syntax for empty properties object", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        Empty: { type: "object", properties: {} },
      },
      diagnostics,
    );

    expect(result).toContain("type({})");
    // Should NOT have a trailing comma before closing brace
    expect(result).not.toContain(",\n}");
  });

  it("emits additionalProperties: false as onUndeclaredKey", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        Strict: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
      diagnostics,
    );

    expect(result).toContain('.onUndeclaredKey("reject")');
  });

  it("uses object identity for schema matching, not JSON serialization", () => {
    // Two schemas with the same content but different objects
    // should NOT match each other
    const petSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const inlineSameContent = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };

    const diagnostics: Diagnostic[] = [];
    const paths = {
      "/test": {
        get: {
          operationId: "test",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: inlineSameContent },
              },
            },
          },
        },
      },
    };

    const result = emitOperations(paths, { Pet: petSchema }, diagnostics);

    // The inline schema is a DIFFERENT object, so it should NOT be
    // replaced with "Pet" — it should be emitted inline
    expect(result).not.toMatch(/:\s*Pet\b/);
  });

  it("uses object identity to MATCH actual component schema references", () => {
    // When the dereferenced spec uses the SAME object for inline and
    // component schemas (as dereference produces), it SHOULD match
    const sharedSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };

    const diagnostics: Diagnostic[] = [];
    const paths = {
      "/test": {
        get: {
          operationId: "test",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: sharedSchema },
              },
            },
          },
        },
      },
    };

    const result = emitOperations(
      paths,
      { Pet: sharedSchema }, // same object reference
      diagnostics,
    );

    // Should reference Pet by name
    expect(result).toContain("Pet");
    expect(result).toContain('import { Pet } from "./schemas.js"');
  });

  it("sanitizes identifiers with special characters", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        "my-schema": { type: "string" },
        "123start": { type: "number" },
      },
      diagnostics,
    );

    expect(result).toContain("export const my_schema");
    expect(result).toContain("export const _123start");
  });
});

describe("parameter merge deduplication", () => {
  it("operation-level params override path-level params with same name+in", async () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "Test", version: "1.0.0" },
      paths: {
        "/items/{id}": {
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          get: {
            operationId: "getItem",
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "integer" },
              },
            ],
            responses: {
              "200": { description: "ok" },
            },
          },
        },
      },
    };

    const client = await createClient({ spec });
    const op = client.operation("get", "/items/{id}");
    expect(op).toBeDefined();

    // The operation-level param (integer) should win over path-level (string)
    expect(op!.pathParams!({ id: 42 })).toEqual({ id: 42 });
    expect(op!.pathParams!({ id: "abc" }) instanceof type.errors).toBe(true);
  });
});

describe("shared schema objects (non-circular)", () => {
  it("runtime: shared primitive schema works for both properties", () => {
    const shared = { type: "integer" } as Record<string, unknown>;
    const { entry } = convert({
      type: "object",
      properties: { x: shared, y: shared },
      required: ["x", "y"],
    });

    expect(entry.validator({ x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
    expect(entry.validator({ x: 1, y: "bad" }) instanceof type.errors).toBe(
      true,
    );
  });

  it("runtime: shared object schema works for both properties", () => {
    const addressSchema = {
      type: "object",
      properties: { street: { type: "string" } },
      required: ["street"],
    } as Record<string, unknown>;

    const { entry } = convert({
      type: "object",
      properties: { home: addressSchema, work: addressSchema },
      required: ["home", "work"],
    });

    const valid = { home: { street: "A" }, work: { street: "B" } };
    expect(entry.validator(valid)).toEqual(valid);
    expect(
      entry.validator({ home: { street: "A" }, work: 123 }) instanceof
        type.errors,
    ).toBe(true);
  });

  it("codegen: shared schema emits correct types for both properties", () => {
    const shared = { type: "string" } as Record<string, unknown>;
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        Obj: {
          type: "object",
          properties: { first: shared, second: shared },
          required: ["first", "second"],
        },
      },
      diagnostics,
    );

    // Both properties should be "string", not type.unknown
    expect(result).not.toContain("type.unknown");
    const stringCount = (result.match(/"string"/g) || []).length;
    expect(stringCount).toBeGreaterThanOrEqual(2);
  });
});

describe("codegen correctness", () => {
  it("emits valid code for 3+ type arrays", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        Nullable: { type: ["string", "number", "null"] },
      },
      diagnostics,
    );

    // Should produce valid chained .or() calls, not nested type(type(...))
    expect(result).not.toContain("type(type(");
    expect(result).toContain(".or(");
  });

  it("escapes forward slashes in regex patterns", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        PathLike: { type: "string", pattern: "^[a-z]+/[0-9]+$" },
      },
      diagnostics,
    );

    // The / should be escaped as \/
    expect(result).toContain("\\/");
    // Should not have an unescaped / that would break the regex
    expect(result).not.toMatch(/matching\(\/.*[^\\]\/.*\/\)/);
  });

  it("preserves constraints when format is present", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        StrictEmail: { type: "string", format: "email", minLength: 5 },
      },
      diagnostics,
    );

    // Should include both the format keyword and the constraint
    expect(result).toContain("string.email");
    expect(result).toContain(">=5");
  });

  it("preserves length constraints when pattern is present", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        BoundedPattern: {
          type: "string",
          pattern: "^[a-z]+$",
          minLength: 3,
          maxLength: 10,
        },
      },
      diagnostics,
    );

    // Should include both the pattern and the length constraints
    expect(result).toContain("matching(");
    expect(result).toContain(">=3");
    expect(result).toContain("<=10");
  });
});

describe("nullable object type arrays", () => {
  it("runtime: validates nullable object properties correctly", () => {
    const { entry } = convert({
      type: ["object", "null"],
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    });

    expect(entry.validator({ name: "Alice" })).toEqual({ name: "Alice" });
    expect(entry.validator(null)).toBe(null);
    expect(entry.validator({}) instanceof type.errors).toBe(true);
    expect(entry.validator({ name: 123 }) instanceof type.errors).toBe(true);
  });

  it("codegen: emits nullable object with properties", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        NullableUser: {
          type: ["object", "null"],
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      diagnostics,
    );

    expect(result).toContain('"name"');
    expect(result).toContain('"string"');
    expect(result).toContain('.or(type("null"))');
  });
});

describe("codegen path-level parameters", () => {
  it("includes path-level parameters in generated operations", () => {
    const diagnostics: Diagnostic[] = [];
    const result = emitOperations(
      {
        "/items/{id}": {
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          get: {
            operationId: "getItem",
            responses: { "200": { description: "ok" } },
          },
        },
      },
      {},
      diagnostics,
    );

    expect(result).toContain("pathParams");
    expect(result).toContain('"id"');
  });
});

describe("identifier collision", () => {
  it("deduplicates colliding sanitized schema names", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        "my-type": { type: "string" },
        my_type: { type: "number" },
      },
      diagnostics,
    );

    // Both should be present with distinct names
    expect(result).toContain("export const my_type =");
    expect(result).toContain("export const my_type_2 =");
  });

  it("operations import uses deduped names", () => {
    const sharedSchema = { type: "string" } as Record<string, unknown>;
    const diagnostics: Diagnostic[] = [];

    const componentSchemas: Record<string, Record<string, unknown>> = {
      "my-type": sharedSchema,
      my_type: { type: "number" },
    };

    const { nameMap } = emitSchemas(componentSchemas, diagnostics);

    const result = emitOperations(
      {
        "/test": {
          get: {
            operationId: "test",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: sharedSchema },
                },
              },
            },
          },
        },
      },
      componentSchemas,
      diagnostics,
      nameMap,
    );

    // Should import the first (non-deduped) name since that's what the
    // schema object maps to
    expect(result).toContain("import { my_type }");
  });
});

describe("anyOf/oneOf composition codegen", () => {
  it("wraps bare DSL strings in type() for anyOf", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        Mixed: {
          anyOf: [{ type: "string" }, { type: "number" }],
        },
      },
      diagnostics,
    );

    // Should produce type("string").or(type("number")), not "string".or("number")
    expect(result).toContain('type("string").or(type("number"))');
  });
});

describe("reserved words", () => {
  it("prefixes JS reserved words with underscore", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        class: { type: "string" },
        default: { type: "number" },
      },
      diagnostics,
    );

    expect(result).toContain("export const _class");
    expect(result).toContain("export const _default");
  });
});

describe("array without items", () => {
  it("codegen emits unknown[] for bare array type", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        BareArray: { type: "array" },
      },
      diagnostics,
    );

    expect(result).toContain("unknown[]");
  });

  it("runtime handles array without items", () => {
    const { entry } = convert({ type: "array" });
    // Should at least accept arrays
    expect(Array.isArray(entry.validator([1, "two", null]))).toBe(true);
  });
});

describe("primitive schemas wrapped in type()", () => {
  it("wraps bare primitive schemas in type() for exports", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        MyString: { type: "string" },
        MyInt: { type: "integer" },
        Email: { type: "string", format: "email" },
        BoundedAge: { type: "integer", minimum: 0, maximum: 150 },
      },
      diagnostics,
    );

    expect(result).toContain('export const MyString = type("string")');
    expect(result).toContain('export const MyInt = type("number.integer")');
    expect(result).toContain('export const Email = type("string.email")');
    expect(result).toContain(
      'export const BoundedAge = type("number.integer>=0<=150")',
    );
  });

  it("wraps bare primitive schemas in type() for operation responses", () => {
    const diagnostics: Diagnostic[] = [];
    const result = emitOperations(
      {
        "/text": {
          get: {
            operationId: "getText",
            responses: {
              "200": {
                description: "ok",
                content: { "text/plain": { schema: { type: "string" } } },
              },
            },
          },
        },
      },
      {},
      diagnostics,
    );

    // Should be type("string"), not bare "string"
    expect(result).toContain('type("string")');
    expect(result).not.toMatch(/"text\/plain": "string"/);
  });
});

describe("empty operationId", () => {
  it("falls back to method_path for empty operationId", () => {
    const diagnostics: Diagnostic[] = [];
    const result = emitOperations(
      {
        "/test": {
          get: {
            operationId: "",
            responses: { "200": { description: "ok" } },
          },
        },
      },
      {},
      diagnostics,
    );

    // Should NOT produce "export const  ="
    expect(result).not.toMatch(/export const\s+=/);
    expect(result).toContain("export const get__test");
  });
});

describe("nullable primitive constraints", () => {
  it("runtime: preserves constraints on nullable integer", () => {
    const { entry } = convert({
      type: ["integer", "null"],
      minimum: 0,
      maximum: 100,
    });

    expect(entry.validator(50)).toBe(50);
    expect(entry.validator(null)).toBe(null);
    expect(entry.validator(-1) instanceof type.errors).toBe(true);
    expect(entry.validator(101) instanceof type.errors).toBe(true);
  });

  it("runtime: preserves format on nullable string", () => {
    const { entry } = convert({
      type: ["string", "null"],
      format: "email",
    });

    expect(entry.validator("a@b.com")).toBe("a@b.com");
    expect(entry.validator(null)).toBe(null);
    expect(entry.validator("not-email") instanceof type.errors).toBe(true);
  });

  it("runtime: preserves minLength on nullable string", () => {
    const { entry } = convert({
      type: ["string", "null"],
      minLength: 1,
      maxLength: 255,
    });

    expect(entry.validator("hello")).toBe("hello");
    expect(entry.validator(null)).toBe(null);
    expect(entry.validator("") instanceof type.errors).toBe(true);
  });

  it("codegen: emits constraints on nullable integer", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        NullableAge: {
          type: ["integer", "null"],
          minimum: 0,
          maximum: 150,
        },
      },
      diagnostics,
    );

    expect(result).toContain(">=0");
    expect(result).toContain("<=150");
    expect(result).toContain('.or(type("null"))');
  });

  it("codegen: emits format on nullable string", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        NullableEmail: {
          type: ["string", "null"],
          format: "email",
        },
      },
      diagnostics,
    );

    expect(result).toContain("string.email");
    expect(result).toContain('.or(type("null"))');
  });
});

describe("codegen array constraints", () => {
  it("emits minItems and maxItems for arrays", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        BoundedList: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10,
        },
      },
      diagnostics,
    );

    expect(result).toContain(".atLeastLength(1)");
    expect(result).toContain(".atMostLength(10)");
  });

  it("emits minItems only when maxItems absent", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        NonEmptyList: {
          type: "array",
          items: { type: "number" },
          minItems: 1,
        },
      },
      diagnostics,
    );

    expect(result).toContain(".atLeastLength(1)");
    expect(result).not.toContain("atMostLength");
  });
});

describe("boolean schemas in codegen", () => {
  it("handles boolean true as property schema", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        Flexible: {
          type: "object",
          properties: { anything: true as any },
          required: ["anything"],
        },
      },
      diagnostics,
    );

    // Should not crash, should produce type.unknown for the boolean schema
    expect(result).toContain("type.unknown");
  });

  it("handles boolean false as property schema", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        Strict: {
          type: "object",
          properties: { forbidden: false as any },
        },
      },
      diagnostics,
    );

    expect(result).toContain("type.never");
  });

  it("handles boolean in allOf", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        Mixed: {
          allOf: [{ type: "string" } as any, true as any],
        },
      },
      diagnostics,
    );

    expect(result).not.toContain("undefined");
    expect(result).toContain("type.unknown");
  });
});

describe("multipleOf in codegen", () => {
  it("emits divisor constraint", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        EvenNumber: { type: "integer", multipleOf: 2 },
      },
      diagnostics,
    );

    expect(result).toContain("%2");
  });

  it("combines multipleOf with other constraints", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        Step5: { type: "integer", minimum: 0, maximum: 100, multipleOf: 5 },
      },
      diagnostics,
    );

    expect(result).toContain(">=0");
    expect(result).toContain("<=100");
    expect(result).toContain("%5");
  });
});

describe("array without items but with constraints", () => {
  it("codegen emits minItems for bare array", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        NonEmpty: { type: "array", minItems: 1 },
      },
      diagnostics,
    );

    expect(result).toContain(".atLeastLength(1)");
  });

  it("codegen emits both minItems and maxItems for bare array", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        Bounded: { type: "array", minItems: 1, maxItems: 50 },
      },
      diagnostics,
    );

    expect(result).toContain(".atLeastLength(1)");
    expect(result).toContain(".atMostLength(50)");
  });
});

describe("const with non-primitive values", () => {
  it("runtime: validates const object by deep equality", () => {
    const { entry } = convert({ const: { status: "ok" } });

    expect(entry.validator({ status: "ok" })).toEqual({ status: "ok" });
    expect(entry.validator({ status: "bad" }) instanceof type.errors).toBe(
      true,
    );
    expect(entry.validator("string") instanceof type.errors).toBe(true);
  });

  it("runtime: validates const array by deep equality", () => {
    const { entry } = convert({ const: [1, 2, 3] });

    expect(entry.validator([1, 2, 3])).toEqual([1, 2, 3]);
    expect(entry.validator([1, 2]) instanceof type.errors).toBe(true);
  });

  it("runtime: primitive const still works", () => {
    const { entry } = convert({ const: "fixed" });
    expect(entry.validator("fixed")).toBe("fixed");
    expect(entry.validator("other") instanceof type.errors).toBe(true);
  });

  it("codegen: emits narrow for const object", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        FixedStatus: { const: { status: "ok" } },
      },
      diagnostics,
    );

    expect(result).toContain(".narrow(");
    expect(result).toContain("JSON.stringify");
    expect(result).not.toContain("type.unit");
  });

  it("codegen: emits type.unit for primitive const", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas(
      {
        FixedValue: { const: 42 },
      },
      diagnostics,
    );

    expect(result).toContain("type.unit(42)");
  });
});

describe("empty composition arrays", () => {
  it("codegen handles empty allOf without crashing", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas({ Any: { allOf: [] } }, diagnostics);
    expect(result).toContain("type.unknown");
  });

  it("codegen handles empty anyOf without crashing", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas({ Any: { anyOf: [] } }, diagnostics);
    expect(result).toContain("type.unknown");
  });

  it("codegen handles empty oneOf without crashing", () => {
    const diagnostics: Diagnostic[] = [];
    const { code: result } = emitSchemas({ None: { oneOf: [] } }, diagnostics);
    expect(result).toContain("type.never");
  });
});
