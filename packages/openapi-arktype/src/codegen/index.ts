import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSpec } from "../parse/load.js";
import type { CreateClientOptions, Diagnostic } from "../types.js";
import { emitIndex, emitOperations, emitSchemas } from "./emit.js";

export interface GenerateOptions extends CreateClientOptions {
  outDir: string;
}

export interface GenerateResult {
  files: string[];
  diagnostics: Diagnostic[];
}

export async function generate(
  options: GenerateOptions,
): Promise<GenerateResult> {
  const diagnostics: Diagnostic[] = [];
  const { spec } = await loadSpec(options);
  const files: string[] = [];

  const schemas = spec.components?.schemas;
  const paths = spec.paths;

  await mkdir(options.outDir, { recursive: true });

  const hasSchemas = schemas !== undefined && Object.keys(schemas).length > 0;
  const hasOperations = paths !== undefined && Object.keys(paths).length > 0;

  let schemaNameMap: Map<string, string> | undefined;

  if (hasSchemas) {
    const result = emitSchemas(schemas!, diagnostics);
    schemaNameMap = result.nameMap;
    const schemasPath = join(options.outDir, "schemas.ts");
    await writeFile(schemasPath, result.code);
    files.push(schemasPath);
  }

  if (hasOperations) {
    const componentSchemas = hasSchemas ? schemas! : {};
    const operationsCode = emitOperations(
      paths!,
      componentSchemas,
      diagnostics,
      schemaNameMap,
    );
    const operationsPath = join(options.outDir, "operations.ts");
    await writeFile(operationsPath, operationsCode);
    files.push(operationsPath);
  }

  const indexCode = emitIndex(hasSchemas, hasOperations);
  const indexPath = join(options.outDir, "index.ts");
  await writeFile(indexPath, indexCode);
  files.push(indexPath);

  return { files, diagnostics };
}
