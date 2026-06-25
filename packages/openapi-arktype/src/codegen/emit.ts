import { FORMAT_MAP } from "../parse/formats.js";
import type { Diagnostic } from "../types.js";
import type {
  JSONSchema,
  OASPathItem,
  OASOperation,
  OASParameter,
} from "../parse/spec-types.js";

interface EmitContext {
  diagnostics: Diagnostic[];
  // Maps object identity of component schemas to their names
  componentSchemaObjects: Map<object, string>;
  // Track seen objects for cycle detection
  seen: Set<object>;
  indent: number;
}

export interface EmitSchemasResult {
  code: string;
  // Maps original schema name to the (possibly deduped) identifier
  nameMap: Map<string, string>;
}

export function emitSchemas(
  schemas: Record<string, JSONSchema>,
  diagnostics: Diagnostic[],
): EmitSchemasResult {
  const ctx: EmitContext = {
    diagnostics,
    componentSchemaObjects: new Map(),
    seen: new Set(),
    indent: 0,
  };

  const lines: string[] = ['import { type } from "arktype"', ""];
  const usedIds = new Set<string>();
  const nameMap = new Map<string, string>();

  for (const [name, schema] of Object.entries(schemas)) {
    ctx.seen = new Set();
    const expr = schemaToExpression(schema, ctx, [
      "components",
      "schemas",
      name,
    ]);
    const id = deduplicateIdentifier(sanitizeIdentifier(name), usedIds);
    nameMap.set(name, id);
    lines.push(`export const ${id} = ${wrapDsl(expr)}`);
    lines.push("");
  }

  return { code: lines.join("\n"), nameMap };
}

export function emitOperations(
  paths: Record<string, OASPathItem>,
  componentSchemas: Record<string, JSONSchema>,
  diagnostics: Diagnostic[],
  schemaNameMap?: Map<string, string>,
): string {
  // Use object identity to match inline schemas to named components.
  // Map to the deduped identifier if a nameMap is provided.
  const componentSchemaObjects = new Map<object, string>();
  for (const [name, schema] of Object.entries(componentSchemas)) {
    const id = schemaNameMap?.get(name) ?? sanitizeIdentifier(name);
    componentSchemaObjects.set(schema, id);
  }

  const ctx: EmitContext = {
    diagnostics,
    componentSchemaObjects,
    seen: new Set(),
    indent: 0,
  };

  const operationBlocks: { name: string; code: string }[] = [];
  const methods = [
    "get",
    "post",
    "put",
    "delete",
    "patch",
    "head",
    "options",
    "trace",
  ];

  const referencedSchemaNames = new Set<string>();
  const usedOpIds = new Set<string>();

  for (const [pathStr, pathObj] of Object.entries(paths)) {
    const pathParams = pathObj.parameters ?? [];

    for (const method of methods) {
      const op = pathObj[method as keyof OASPathItem] as
        | OASOperation
        | undefined;
      if (!op || typeof op !== "object") continue;

      const opId =
        op.operationId || `${method}_${pathStr.replace(/[^a-zA-Z0-9]/g, "_")}`;

      // Merge path-level and operation-level parameters.
      // Operation-level overrides path-level with same name+in.
      const opParams = op.parameters ?? [];
      const mergedOp = mergeParams(pathParams, opParams, op);

      ctx.seen = new Set();
      const code = emitOperation(
        mergedOp,
        ctx,
        ["paths", pathStr, method],
        referencedSchemaNames,
      );
      const opName = deduplicateIdentifier(sanitizeIdentifier(opId), usedOpIds);
      operationBlocks.push({ name: opName, code });
    }
  }

  const lines: string[] = [];
  lines.push('import { type } from "arktype"');
  if (referencedSchemaNames.size > 0) {
    // Names are already deduped identifiers from componentSchemaObjects
    const imports = [...referencedSchemaNames].join(", ");
    lines.push(`import { ${imports} } from "./schemas.js"`);
  }
  lines.push("");

  for (const block of operationBlocks) {
    lines.push(`export const ${block.name} = ${block.code}`);
    lines.push("");
  }

  return lines.join("\n");
}

function emitOperation(
  op: OASOperation,
  ctx: EmitContext,
  basePath: string[],
  referencedSchemaNames: Set<string>,
): string {
  const parts: string[] = [];
  const i1 = "  ";
  const i2 = "    ";
  const i3 = "      ";

  const params = op.parameters;
  if (params && params.length > 0) {
    const queryParams = params.filter((p) => p.in === "query");
    const pathParams = params.filter((p) => p.in === "path");
    const headerParams = params.filter((p) => p.in === "header");

    if (queryParams.length > 0)
      parts.push(
        `${i1}queryParams: ${emitParamsObject(queryParams, ctx, basePath, referencedSchemaNames)}`,
      );
    if (pathParams.length > 0)
      parts.push(
        `${i1}pathParams: ${emitParamsObject(pathParams, ctx, basePath, referencedSchemaNames)}`,
      );
    if (headerParams.length > 0)
      parts.push(
        `${i1}headerParams: ${emitParamsObject(headerParams, ctx, basePath, referencedSchemaNames)}`,
      );
  }

  if (op.requestBody?.content) {
    const bodyParts: string[] = [];
    for (const [mediaType, mtObj] of Object.entries(op.requestBody.content)) {
      if (mtObj.schema) {
        const opCtx = { ...ctx, indent: 2, seen: new Set(ctx.seen) };
        const expr = schemaToExpression(
          mtObj.schema,
          opCtx,
          [...basePath, "requestBody", "content", mediaType],
          referencedSchemaNames,
        );
        bodyParts.push(`${i2}${JSON.stringify(mediaType)}: ${wrapDsl(expr)}`);
      }
    }
    if (bodyParts.length > 0) {
      parts.push(`${i1}requestBody: {\n${bodyParts.join(",\n")},\n${i1}}`);
    }
  }

  if (op.responses) {
    const respParts: string[] = [];
    for (const [status, respObj] of Object.entries(op.responses)) {
      if (respObj.content) {
        const contentParts: string[] = [];
        for (const [mediaType, mtObj] of Object.entries(respObj.content)) {
          if (mtObj.schema) {
            const opCtx = { ...ctx, indent: 3, seen: new Set(ctx.seen) };
            const expr = schemaToExpression(
              mtObj.schema,
              opCtx,
              [...basePath, "responses", status, mediaType],
              referencedSchemaNames,
            );
            contentParts.push(
              `${i3}${JSON.stringify(mediaType)}: ${wrapDsl(expr)}`,
            );
          }
        }
        if (contentParts.length > 0) {
          respParts.push(
            `${i2}${JSON.stringify(status)}: {\n${contentParts.join(",\n")},\n${i2}}`,
          );
        }
      }
    }
    if (respParts.length > 0) {
      parts.push(`${i1}responses: {\n${respParts.join(",\n")},\n${i1}}`);
    }
  }

  if (parts.length === 0) return "{}";
  return `{\n${parts.join(",\n")},\n}`;
}

function emitParamsObject(
  params: OASParameter[],
  ctx: EmitContext,
  basePath: string[],
  referencedSchemaNames: Set<string>,
): string {
  const props: string[] = [];
  for (const param of params) {
    const key = param.required
      ? JSON.stringify(param.name)
      : JSON.stringify(`${param.name}?`);
    const expr = param.schema
      ? schemaToExpression(param.schema, ctx, basePath, referencedSchemaNames)
      : '"string"';
    props.push(`    ${key}: ${expr}`);
  }
  return `type({\n${props.join(",\n")},\n  })`;
}

function schemaToExpression(
  schema: Record<string, unknown>,
  ctx: EmitContext,
  schemaPath: string[],
  referencedSchemaNames?: Set<string>,
): string {
  // Handle JSON Schema boolean schemas (true = accept all, false = reject all)
  if (typeof schema === "boolean") {
    return schema ? "type.unknown" : "type.never";
  }

  // Check for circular reference
  if (ctx.seen.has(schema)) {
    ctx.diagnostics.push({
      level: "warn",
      path: schemaPath,
      message:
        "Circular schema reference detected in codegen, emitting type.unknown",
      code: "SCHEMA_CONVERSION_ERROR",
    });
    return "type.unknown";
  }
  ctx.seen.add(schema);
  try {
    return schemaToExpressionInner(
      schema,
      ctx,
      schemaPath,
      referencedSchemaNames,
    );
  } finally {
    ctx.seen.delete(schema);
  }
}

function schemaToExpressionInner(
  schema: Record<string, unknown>,
  ctx: EmitContext,
  schemaPath: string[],
  referencedSchemaNames?: Set<string>,
): string {
  // Check if this schema IS a named component schema (by object identity)
  const matchedName = ctx.componentSchemaObjects.get(schema);
  if (matchedName) {
    referencedSchemaNames?.add(matchedName);
    return sanitizeIdentifier(matchedName);
  }

  // Enum
  if ("enum" in schema && Array.isArray(schema.enum)) {
    const values = schema.enum.map((v) => JSON.stringify(v)).join(", ");
    return `type.enumerated(${values})`;
  }

  // Const
  if ("const" in schema) {
    const val = schema.const;
    if (val !== null && typeof val === "object") {
      const serialized = JSON.stringify(val);
      const baseType = Array.isArray(val)
        ? 'type("unknown[]")'
        : 'type("object")';
      return `${baseType}.narrow((v) => JSON.stringify(v) === ${JSON.stringify(serialized)})`;
    }
    return `type.unit(${JSON.stringify(val)})`;
  }

  // Object with properties — handle type: "object" and type: ["object", "null"]
  const typeIsObject =
    schema.type === "object" ||
    (Array.isArray(schema.type) &&
      (schema.type as string[]).includes("object"));
  if (typeIsObject && schema.properties) {
    let expr = emitObjectExpression(
      schema,
      ctx,
      schemaPath,
      referencedSchemaNames,
    );
    if (
      Array.isArray(schema.type) &&
      (schema.type as string[]).includes("null")
    ) {
      expr = `${expr}.or(type("null"))`;
    }
    return expr;
  }

  // Array — handle type: "array" and type: ["array", "null"]
  const typeIsArray =
    schema.type === "array" ||
    (Array.isArray(schema.type) && (schema.type as string[]).includes("array"));
  if (typeIsArray && schema.items) {
    const itemExpr = schemaToExpression(
      schema.items as Record<string, unknown>,
      ctx,
      [...schemaPath, "items"],
      referencedSchemaNames,
    );
    const nullable =
      Array.isArray(schema.type) && (schema.type as string[]).includes("null");
    const nullSuffix = nullable ? `.or(type("null"))` : "";

    // Build array constraint chain
    const constraints: string[] = [];
    if (typeof schema.minItems === "number")
      constraints.push(`.atLeastLength(${schema.minItems})`);
    if (typeof schema.maxItems === "number")
      constraints.push(`.atMostLength(${schema.maxItems})`);
    const constraintSuffix = constraints.join("");

    // If it's a simple string literal, use DSL array syntax
    if (
      itemExpr.startsWith('"') &&
      !itemExpr.includes("(") &&
      !itemExpr.includes("{")
    ) {
      const inner = itemExpr.slice(1, -1);
      if (constraintSuffix) {
        return `type("${inner}[]")${constraintSuffix}${nullSuffix}`;
      }
      return `type("${inner}[]")${nullSuffix}`;
    }
    return `${itemExpr}.array()${constraintSuffix}${nullSuffix}`;
  }

  // Composition — ensure first expression is wrapped in type() if it's
  // a bare DSL string, so .and()/.or() can be chained on it
  if ("allOf" in schema && Array.isArray(schema.allOf)) {
    const exprs = (schema.allOf as Record<string, unknown>[]).map((s, i) =>
      schemaToExpression(
        s,
        ctx,
        [...schemaPath, "allOf", String(i)],
        referencedSchemaNames,
      ),
    );
    if (exprs.length === 0) return "type.unknown";
    return exprs.map(wrapDsl).reduce((acc, expr) => `${acc}.and(${expr})`);
  }

  if ("anyOf" in schema && Array.isArray(schema.anyOf)) {
    const exprs = (schema.anyOf as Record<string, unknown>[]).map((s, i) =>
      schemaToExpression(
        s,
        ctx,
        [...schemaPath, "anyOf", String(i)],
        referencedSchemaNames,
      ),
    );
    if (exprs.length === 0) return "type.unknown";
    return exprs.map(wrapDsl).reduce((acc, expr) => `${acc}.or(${expr})`);
  }

  if ("oneOf" in schema && Array.isArray(schema.oneOf)) {
    const exprs = (schema.oneOf as Record<string, unknown>[]).map((s, i) =>
      schemaToExpression(
        s,
        ctx,
        [...schemaPath, "oneOf", String(i)],
        referencedSchemaNames,
      ),
    );
    if (exprs.length === 0) return "type.never";
    return exprs.map(wrapDsl).reduce((acc, expr) => `${acc}.or(${expr})`);
  }

  // Type array (nullable in 3.1 style).
  // For nullable primitives with constraints/format/pattern, build the
  // non-null type with all constraints then .or() with null.
  if (Array.isArray(schema.type)) {
    const schemaTypes = schema.type as string[];
    if (schemaTypes.includes("null") && schemaTypes.length === 2) {
      const nonNull = schemaTypes.find((t) => t !== "null")!;
      const singleTypeSchema = { ...schema, type: nonNull };
      const baseExpr = schemaToExpression(
        singleTypeSchema,
        ctx,
        schemaPath,
        referencedSchemaNames,
      );
      return `${wrapDsl(baseExpr)}.or(type("null"))`;
    }
    const types = schemaTypes.map((t) => `type("${mapPrimitiveType(t)}")`);
    return types.reduce((acc, t) => `${acc}.or(${t})`);
  }

  // Simple primitives
  if (typeof schema.type === "string") {
    return emitPrimitiveExpression(schema, ctx.diagnostics, schemaPath);
  }

  // Fallback — use safeStringify to handle potential circular refs
  return `type.unknown /* unsupported schema */`;
}

function emitObjectExpression(
  schema: Record<string, unknown>,
  ctx: EmitContext,
  schemaPath: string[],
  referencedSchemaNames?: Set<string>,
): string {
  const properties = schema.properties as Record<
    string,
    Record<string, unknown>
  >;
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );

  const indent = "  ".repeat(ctx.indent);
  const propIndent = indent + "  ";

  const propEntries = Object.entries(properties);

  // Handle empty properties
  if (propEntries.length === 0) {
    const result = `type({})`;
    if (schema.additionalProperties === false) {
      return `${result}.onUndeclaredKey("reject")`;
    }
    return result;
  }

  const props: string[] = [];
  for (const [propName, propSchema] of propEntries) {
    const key = required.has(propName) ? propName : `${propName}?`;
    const propCtx = { ...ctx, indent: ctx.indent + 1 };
    const expr = schemaToExpression(
      propSchema,
      propCtx,
      [...schemaPath, "properties", propName],
      referencedSchemaNames,
    );
    props.push(`${propIndent}${JSON.stringify(key)}: ${expr}`);
  }

  let result = `type({\n${props.join(",\n")},\n${indent}})`;

  if (schema.additionalProperties === false) {
    result = `${result}.onUndeclaredKey("reject")`;
  }

  return result;
}

function emitPrimitiveExpression(
  schema: Record<string, unknown>,
  diagnostics: Diagnostic[],
  schemaPath: string[],
): string {
  let effectiveType = mapPrimitiveType(schema.type as string);
  const constraints: string[] = [];
  const chainCalls: string[] = [];

  // Format — use arktype keyword if available, but don't return early
  // so constraints below are still collected
  if (typeof schema.format === "string") {
    const mapped = FORMAT_MAP[schema.format];
    if (mapped) {
      effectiveType = mapped;
    } else if (!["int32", "int64", "float", "double"].includes(schema.format)) {
      diagnostics.push({
        level: "warn",
        path: schemaPath,
        message: `Unknown format "${schema.format}" ignored in codegen`,
        code: "UNSUPPORTED_FORMAT",
      });
    }
  }

  if (typeof schema.minLength === "number")
    constraints.push(`>=${schema.minLength}`);
  if (typeof schema.maxLength === "number")
    constraints.push(`<=${schema.maxLength}`);

  // Pattern — escape forward slashes for regex literal, and collect
  // as a chain call so constraints aren't lost
  if (typeof schema.pattern === "string") {
    const escaped = schema.pattern.replace(/\//g, "\\/");
    chainCalls.push(`.matching(/${escaped}/)`);
  }

  if (typeof schema.minimum === "number")
    constraints.push(`>=${schema.minimum}`);
  if (typeof schema.exclusiveMinimum === "number")
    constraints.push(`>${schema.exclusiveMinimum}`);
  if (typeof schema.maximum === "number")
    constraints.push(`<=${schema.maximum}`);
  if (typeof schema.exclusiveMaximum === "number")
    constraints.push(`<${schema.exclusiveMaximum}`);
  if (typeof schema.multipleOf === "number")
    constraints.push(`%${schema.multipleOf}`);

  // Array without items — handle minItems/maxItems as chain calls
  if (schema.type === "array") {
    if (typeof schema.minItems === "number")
      chainCalls.push(`.atLeastLength(${schema.minItems})`);
    if (typeof schema.maxItems === "number")
      chainCalls.push(`.atMostLength(${schema.maxItems})`);
  }

  const dsl =
    constraints.length > 0
      ? `"${effectiveType}${constraints.join("")}"`
      : `"${effectiveType}"`;

  if (chainCalls.length > 0) {
    return `type(${dsl})${chainCalls.join("")}`;
  }

  return dsl;
}

function mapPrimitiveType(jsonSchemaType: string): string {
  switch (jsonSchemaType) {
    case "integer":
      return "number.integer";
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return "unknown[]";
    case "object":
      return "object";
    default:
      return jsonSchemaType;
  }
}

function mergeParams(
  pathParams: OASParameter[],
  opParams: OASParameter[],
  op: OASOperation,
): OASOperation {
  if (pathParams.length === 0) return op;

  const opParamKeys = new Set(opParams.map((p) => `${p.in}:${p.name}`));
  const inherited = pathParams.filter(
    (p) => !opParamKeys.has(`${p.in}:${p.name}`),
  );

  if (inherited.length === 0) return op;

  return {
    ...op,
    parameters: [...inherited, ...opParams],
  };
}

const JS_RESERVED = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "await",
  "async",
]);

function sanitizeIdentifier(name: string): string {
  let result = name.replace(/[^a-zA-Z0-9_$]/g, "_");
  if (/^[0-9]/.test(result)) result = `_${result}`;
  if (JS_RESERVED.has(result)) result = `_${result}`;
  return result;
}

// Wrap bare DSL string expressions in type() so methods like .or() can chain
function wrapDsl(expr: string): string {
  if (expr.startsWith('"') && expr.endsWith('"')) {
    return `type(${expr})`;
  }
  return expr;
}

function deduplicateIdentifier(id: string, used: Set<string>): string {
  if (!used.has(id)) {
    used.add(id);
    return id;
  }
  let n = 2;
  while (used.has(`${id}_${n}`)) n++;
  const deduped = `${id}_${n}`;
  used.add(deduped);
  return deduped;
}

export function emitIndex(hasSchemas: boolean, hasOperations: boolean): string {
  const lines: string[] = [];
  if (hasSchemas) lines.push('export * from "./schemas.js"');
  if (hasOperations) lines.push('export * from "./operations.js"');
  return lines.join("\n") + "\n";
}
