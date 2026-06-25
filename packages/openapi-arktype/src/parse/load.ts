import { type } from "arktype";
import { dereference, upgrade } from "@scalar/openapi-parser";
import { readFile } from "node:fs/promises";
import { OpenApiArktypeError } from "../types.js";
import type { CreateClientOptions } from "../types.js";
import { oasTypes, type OASSpec } from "./spec-types.js";

export interface LoadedSpec {
  spec: OASSpec;
  version: string;
}

export async function loadSpec(
  options: CreateClientOptions,
): Promise<LoadedSpec> {
  const raw = await resolveInput(options);

  // For object inputs, upgrade 3.0 before dereferencing
  if (typeof raw === "object") {
    const version = String((raw as Record<string, unknown>).openapi ?? "");
    const toDeref = version.startsWith("3.0")
      ? upgradeSpec(raw as Record<string, unknown>)
      : (raw as Record<string, unknown>);
    return deref(toDeref);
  }

  // For string inputs, dereference first (handles YAML/JSON parsing),
  // then check if 3.0 and re-dereference after upgrade if needed.
  const result = dereference(raw);
  if (result.errors && result.errors.length > 0) {
    throw new OpenApiArktypeError(
      "DEREFERENCE_FAILED",
      `Failed to dereference spec: ${result.errors.map((e: { message?: string }) => e.message).join(", ")}`,
      result.errors,
    );
  }

  const rawSpec = result.schema;
  if (!rawSpec || typeof rawSpec !== "object") {
    throw new OpenApiArktypeError(
      "INVALID_SPEC",
      "Dereferenced spec is empty or invalid",
    );
  }

  const version = String((rawSpec as Record<string, unknown>).openapi ?? "");
  if (version.startsWith("3.0")) {
    const upgraded = upgradeSpec(
      (result.specification as Record<string, unknown>) ??
        (rawSpec as Record<string, unknown>),
    );
    return deref(upgraded);
  }

  return validateSpec(
    rawSpec as Record<string, unknown>,
    result.version ?? "3.1",
  );
}

function validateSpec(
  raw: Record<string, unknown>,
  version: string,
): LoadedSpec {
  const result = oasTypes.openApiSpec(raw);
  if (result instanceof type.errors) {
    throw new OpenApiArktypeError(
      "INVALID_SPEC",
      `OpenAPI spec validation failed: ${result.summary}`,
      result,
    );
  }
  return { spec: result, version };
}

function deref(input: Record<string, unknown>): LoadedSpec {
  const result = dereference(input);

  if (result.errors && result.errors.length > 0) {
    throw new OpenApiArktypeError(
      "DEREFERENCE_FAILED",
      `Failed to dereference spec: ${result.errors.map((e: { message?: string }) => e.message).join(", ")}`,
      result.errors,
    );
  }

  if (!result.schema || typeof result.schema !== "object") {
    throw new OpenApiArktypeError(
      "INVALID_SPEC",
      "Dereferenced spec is empty or invalid",
    );
  }

  return validateSpec(
    result.schema as Record<string, unknown>,
    result.version ?? "3.1",
  );
}

function upgradeSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const result = upgrade(spec);
  return (
    (result as { specification?: Record<string, unknown> }).specification ??
    spec
  );
}

async function resolveInput(
  options: CreateClientOptions,
): Promise<string | Record<string, unknown>> {
  const sourceCount = [options.spec, options.url, options.path].filter(
    Boolean,
  ).length;

  if (sourceCount !== 1) {
    throw new OpenApiArktypeError(
      "LOAD_FAILED",
      "Exactly one of spec, url, or path must be provided",
    );
  }

  if (options.spec) {
    return options.spec;
  }

  if (options.url) {
    const response = await fetch(options.url);
    if (!response.ok) {
      throw new OpenApiArktypeError(
        "LOAD_FAILED",
        `Failed to fetch spec from ${options.url}: ${response.status} ${response.statusText}`,
      );
    }
    return response.text();
  }

  if (options.path) {
    try {
      return await readFile(options.path, "utf-8");
    } catch (err) {
      throw new OpenApiArktypeError(
        "LOAD_FAILED",
        `Failed to read spec from ${options.path}: ${(err as Error).message}`,
        err,
      );
    }
  }

  throw new OpenApiArktypeError("LOAD_FAILED", "No input source provided");
}
