import type {
  ApiClient,
  CreateClientOptions,
  Diagnostic,
  HttpMethod,
} from "../types.js"
import { loadSpec } from "../parse/load.js"
import {
  buildApiDescription,
  buildOperationValidators,
} from "../parse/operations.js"

export async function createClient(
  options: CreateClientOptions
): Promise<ApiClient> {
  const diagnostics: Diagnostic[] = []
  const { spec } = await loadSpec(options)
  const api = buildApiDescription(spec, diagnostics)

  const schemas: ApiClient["schemas"] = {}
  for (const [name, entry] of Object.entries(api.schemas)) {
    schemas[name] = entry.validator
  }

  return {
    api,
    schemas,
    diagnostics,
    operation(method: HttpMethod, path: string) {
      const pathItem = api.paths[path]
      if (!pathItem) return undefined

      const op = pathItem.operations[method]
      if (!op) return undefined

      const opParamKeys = new Set(
        op.parameters.map((p) => `${p.in}:${p.name}`)
      )
      const inheritedParams = pathItem.parameters.filter(
        (p) => !opParamKeys.has(`${p.in}:${p.name}`)
      )
      const mergedOp = {
        ...op,
        parameters: [...inheritedParams, ...op.parameters],
      }

      return buildOperationValidators(mergedOp)
    },
  }
}
