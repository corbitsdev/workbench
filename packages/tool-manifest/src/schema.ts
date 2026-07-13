import { type } from "arktype";
import { assertToolManifestFactoryInvariants } from "./invariants";

export const ToolSideEffectSchema = type("'read' | 'write'");
export type ToolSideEffect = typeof ToolSideEffectSchema.infer;

export const ToolManifestCredentialCatalogSchema = type({
  label: "string",
  "secretLabel?": "string",
  "secondaryField?": {
    label: "string",
    placeholder: "string",
    required: "boolean",
  },
  "platforms?": "string[]",
});
export type ToolManifestCredentialCatalog =
  typeof ToolManifestCredentialCatalogSchema.infer;

export const ToolManifestMyraCatalogSchema = type({
  summary: "string",
  tags: "string[]",
  catalogPackage: "string",
});
export type ToolManifestMyraCatalog =
  typeof ToolManifestMyraCatalogSchema.infer;

export const ToolFactoryManifestSchema = type({
  factoryId: "string",
  packageName: "string",
  "providerName?": "string | null",
  bareToolNames: "string[]",
  sideEffects: { "[string]": ToolSideEffectSchema },
  "myraCatalog?": ToolManifestMyraCatalogSchema.or("null"),
  "credentialCatalog?": ToolManifestCredentialCatalogSchema.or("null"),
});
export type ToolFactoryManifest = typeof ToolFactoryManifestSchema.infer;

export const ToolManifestFileSchema = type({
  factories: ToolFactoryManifestSchema.array().atLeastLength(1),
});
export type ToolManifestFile = typeof ToolManifestFileSchema.infer;

export const ToolManifestIndexSchema = type({
  generatedAt: "string",
  factories: ToolFactoryManifestSchema.array(),
});
export type ToolManifestIndex = typeof ToolManifestIndexSchema.infer;

export function parseToolManifestFile(
  value: unknown,
): ToolManifestFile | string {
  const parsed = ToolManifestFileSchema(value);
  if (parsed instanceof type.errors) return parsed.summary;
  return parsed;
}

export function parseToolManifestIndex(
  value: unknown,
): ToolManifestIndex | string {
  const parsed = ToolManifestIndexSchema(value);
  if (parsed instanceof type.errors) return parsed.summary;
  try {
    assertToolManifestFactoryInvariants(parsed.factories);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return parsed;
}
