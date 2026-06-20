import { type, type Type } from "arktype"
import type { Diagnostic, SchemaEntry, SchemaMetadata } from "../types.js"
import { FORMAT_MAP } from "./formats.js"

const METADATA_KEYS: readonly string[] = [
  "readOnly",
  "writeOnly",
  "deprecated",
  "default",
  "example",
  "examples",
  "title",
  "description",
  "externalDocs",
  "xml",
  "discriminator",
]

const PRIMITIVE_TYPE_MAP: Record<string, string> = {
  string: "string",
  number: "number",
  integer: "number.integer",
  boolean: "boolean",
  null: "null",
}

export function convertSchema(
  jsonSchema: Record<string, unknown>,
  diagnostics: Diagnostic[],
  schemaPath: string[] = [],
  name?: string
): SchemaEntry {
  // Boolean schemas (JSON Schema 2020-12) have no metadata
  if (typeof jsonSchema === "boolean") {
    const validator = (jsonSchema ? type.unknown : type.never) as Type<unknown>
    return {
      name,
      jsonSchema,
      validator,
      metadata: { extensions: {} },
    }
  }

  const metadata = extractMetadata(jsonSchema, diagnostics, schemaPath)
  const seen = new Set<object>()
  const validator = buildValidator(jsonSchema, diagnostics, schemaPath, seen)
  return { name, jsonSchema, validator, metadata }
}

function buildValidator(
  schema: Record<string, unknown>,
  diagnostics: Diagnostic[],
  schemaPath: string[],
  seen: Set<object>
): Type<unknown> {
  // Handle boolean schemas (JSON Schema 2020-12)
  if (typeof schema === "boolean") {
    return (schema ? type.unknown : type.never) as Type<unknown>
  }

  // Cycle detection: after dereference, circular $refs become circular
  // object references. If we've seen this exact object, bail out.
  if (seen.has(schema)) {
    diagnostics.push({
      level: "warn",
      path: schemaPath,
      message: "Circular schema reference detected, falling back to unknown",
      code: "SCHEMA_CONVERSION_ERROR",
    })
    return type.unknown as Type<unknown>
  }
  seen.add(schema)
  try {
    // Enum
    if ("enum" in schema && Array.isArray(schema.enum)) {
      return type.enumerated(
        ...(schema.enum as [unknown, ...unknown[]])
      ) as Type<unknown>
    }

    // Const
    if ("const" in schema) {
      return buildConstValidator(schema.const)
    }

    // Object with properties
    const typeIsObject = schema.type === "object" ||
      (Array.isArray(schema.type) && schema.type.includes("object"))
    if (typeIsObject && schema.properties) {
      let result = buildObjectValidator(schema, diagnostics, schemaPath, seen)
      if (Array.isArray(schema.type) && schema.type.includes("null")) {
        result = result.or(type("null") as Type<unknown>) as Type<unknown>
      }
      return result
    }

    // Array with items
    const typeIsArray = schema.type === "array" ||
      (Array.isArray(schema.type) && schema.type.includes("array"))
    if (typeIsArray && schema.items) {
      let result = buildArrayValidator(schema, diagnostics, schemaPath, seen)
      if (Array.isArray(schema.type) && schema.type.includes("null")) {
        result = result.or(type("null") as Type<unknown>) as Type<unknown>
      }
      return result
    }

    // Type arrays (e.g. ["string", "null"], ["string", "number", "null"])
    // Build each non-null type with all constraints applied, then union them.
    // If null is in the array, add it as a union member.
    if (Array.isArray(schema.type)) {
      const types = schema.type as string[]
      const hasNull = types.includes("null")
      const nonNullTypes = types.filter((t) => t !== "null")

      const validators = nonNullTypes.map((t) => {
        const singleTypeSchema = { ...schema, type: t }
        return buildValidator(singleTypeSchema, diagnostics, schemaPath, seen)
      })

      if (hasNull) {
        validators.push(type("null") as Type<unknown>)
      }

      if (validators.length === 0) {
        return type.never as Type<unknown>
      }

      return validators.reduce((acc, v) =>
        acc.or(v) as Type<unknown>
      )
    }

    // Composition
    if ("allOf" in schema && Array.isArray(schema.allOf)) {
      return buildComposition(
        schema.allOf as Record<string, unknown>[],
        "and", diagnostics, schemaPath, seen
      )
    }
    if ("anyOf" in schema && Array.isArray(schema.anyOf)) {
      return buildComposition(
        schema.anyOf as Record<string, unknown>[],
        "or", diagnostics, schemaPath, seen
      )
    }
    if ("oneOf" in schema && Array.isArray(schema.oneOf)) {
      return buildComposition(
        schema.oneOf as Record<string, unknown>[],
        "or", diagnostics, schemaPath, seen
      )
    }

    // Simple primitive with constraints
    if (typeof schema.type === "string") {
      return buildPrimitiveValidator(schema, diagnostics, schemaPath)
    }

    // Fallback
    diagnostics.push({
      level: "warn",
      path: schemaPath,
      message: "Schema has no recognizable type, falling back to unknown",
      code: "SCHEMA_CONVERSION_ERROR",
    })
    return type.unknown as Type<unknown>
  } catch (err) {
    diagnostics.push({
      level: "warn",
      path: schemaPath,
      message: `Schema conversion failed: ${(err as Error).message}`,
      code: "SCHEMA_CONVERSION_ERROR",
    })
    return type.unknown as Type<unknown>
  } finally {
    seen.delete(schema)
  }
}

function buildConstValidator(val: unknown): Type<unknown> {
  if (val !== null && typeof val === "object") {
    const serialized = JSON.stringify(val)
    const baseType = Array.isArray(val) ? type("unknown[]") : type("object")
    return (baseType as any).narrow(
      (v: unknown) => JSON.stringify(v) === serialized
    ) as Type<unknown>
  }
  return type.unit(val) as Type<unknown>
}

function buildObjectValidator(
  schema: Record<string, unknown>,
  diagnostics: Diagnostic[],
  schemaPath: string[],
  seen: Set<object>
): Type<unknown> {
  const properties = schema.properties as Record<string, Record<string, unknown>>
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : []
  )

  const typeDef: Record<string, Type<unknown>> = {}

  for (const [propName, propSchema] of Object.entries(properties)) {
    const propPath = [...schemaPath, "properties", propName]
    const propValidator = buildValidator(propSchema, diagnostics, propPath, seen)
    const key = required.has(propName) ? propName : `${propName}?`
    typeDef[key] = propValidator
  }

  let result = type(typeDef as never) as Type<unknown>

  if (schema.additionalProperties === false) {
    result = (result as any).onUndeclaredKey("reject") as Type<unknown>
  }

  return result
}

function buildArrayValidator(
  schema: Record<string, unknown>,
  diagnostics: Diagnostic[],
  schemaPath: string[],
  seen: Set<object>
): Type<unknown> {
  const itemsSchema = schema.items as Record<string, unknown>
  const itemValidator = buildValidator(
    itemsSchema, diagnostics, [...schemaPath, "items"], seen
  )

  let result: any = itemValidator.array()

  if (typeof schema.minItems === "number") {
    result = result.atLeastLength(schema.minItems)
  }
  if (typeof schema.maxItems === "number") {
    result = result.atMostLength(schema.maxItems)
  }

  return result as Type<unknown>
}

function buildComposition(
  branches: Record<string, unknown>[],
  op: "and" | "or",
  diagnostics: Diagnostic[],
  schemaPath: string[],
  seen: Set<object>
): Type<unknown> {
  if (branches.length === 0) {
    return (op === "and" ? type.unknown : type.never) as Type<unknown>
  }

  const validators = branches.map((s, i) =>
    buildValidator(s, diagnostics, [...schemaPath, String(i)], seen)
  )

  return validators.reduce((acc, v) =>
    (op === "and" ? acc.and(v) : acc.or(v)) as Type<unknown>
  )
}

function buildPrimitiveValidator(
  schema: Record<string, unknown>,
  diagnostics: Diagnostic[],
  schemaPath: string[]
): Type<unknown> {
  const schemaType = schema.type as string

  // Build the DSL constraint string
  const baseType = PRIMITIVE_TYPE_MAP[schemaType] ?? schemaType
  const constraints: string[] = []

  // String constraints
  if (typeof schema.minLength === "number")
    constraints.push(`>=${schema.minLength}`)
  if (typeof schema.maxLength === "number")
    constraints.push(`<=${schema.maxLength}`)

  // Number constraints
  if (typeof schema.minimum === "number")
    constraints.push(`>=${schema.minimum}`)
  if (typeof schema.exclusiveMinimum === "number")
    constraints.push(`>${schema.exclusiveMinimum}`)
  if (typeof schema.maximum === "number")
    constraints.push(`<=${schema.maximum}`)
  if (typeof schema.exclusiveMaximum === "number")
    constraints.push(`<${schema.exclusiveMaximum}`)
  if (typeof schema.multipleOf === "number")
    constraints.push(`%${schema.multipleOf}`)

  // Array without items
  if (schemaType === "array") {
    let result: any = type("unknown[]")
    if (typeof schema.minItems === "number")
      result = result.atLeastLength(schema.minItems)
    if (typeof schema.maxItems === "number")
      result = result.atMostLength(schema.maxItems)
    return result as Type<unknown>
  }

  const dsl = constraints.length > 0
    ? `${baseType}${constraints.join("")}`
    : baseType

  let result = type(dsl as never) as Type<unknown>

  // Pattern
  if (typeof schema.pattern === "string") {
    result = (result as any).matching(new RegExp(schema.pattern)) as Type<unknown>
  }

  // Format
  result = applyFormat(result, schema, diagnostics, schemaPath)

  return result
}

function extractMetadata(
  schema: Record<string, unknown>,
  diagnostics: Diagnostic[],
  schemaPath: string[]
): SchemaMetadata {
  const extensions: Record<string, unknown> = {}

  for (const key of Object.keys(schema)) {
    if (key.startsWith("x-")) {
      extensions[key] = schema[key]
    }
  }

  if ("discriminator" in schema) {
    diagnostics.push({
      level: "info",
      path: schemaPath,
      message:
        "Discriminator stripped (composition keywords handle correctness)",
      code: "STRIPPED_DISCRIMINATOR",
    })
  }

  return {
    readOnly: schema.readOnly as boolean | undefined,
    writeOnly: schema.writeOnly as boolean | undefined,
    deprecated: schema.deprecated as boolean | undefined,
    default: schema.default,
    example: schema.example,
    extensions,
  }
}

function applyFormat(
  baseValidator: Type<unknown>,
  originalSchema: Record<string, unknown>,
  diagnostics: Diagnostic[],
  schemaPath: string[]
): Type<unknown> {
  const format = originalSchema.format
  if (typeof format !== "string") return baseValidator

  const arktypeKeyword = FORMAT_MAP[format]
  if (arktypeKeyword) {
    try {
      const formatType = type(arktypeKeyword as never)
      return baseValidator.and(formatType) as Type<unknown>
    } catch {
      diagnostics.push({
        level: "warn",
        path: schemaPath,
        message: `Could not apply format "${format}" as intersection`,
        code: "UNSUPPORTED_FORMAT",
      })
      return baseValidator
    }
  }

  if (["int32", "int64", "float", "double"].includes(format)) {
    return baseValidator
  }

  diagnostics.push({
    level: "warn",
    path: schemaPath,
    message: `Unknown format "${format}" stripped`,
    code: "UNSUPPORTED_FORMAT",
  })

  return baseValidator
}
