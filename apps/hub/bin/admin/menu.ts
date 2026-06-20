import type { ApiClient } from '@workbench/openapi-arktype';
import type { OperationSummary } from './client';

// Pure helpers behind the interactive admin CLI: turning the spec's operations
// into a tag-grouped menu and extracting the inputs an operation needs. Kept
// separate from the I/O loop in index.ts so the menu logic is unit-testable.

export interface ResourceGroup {
  tag: string;
  operations: OperationSummary[];
}

// Group operations by their first tag (the "resource"), preserving the
// already-sorted order within each group.
export function groupByTag(operations: OperationSummary[]): ResourceGroup[] {
  const byTag = new Map<string, OperationSummary[]>();
  for (const op of operations) {
    const list = byTag.get(op.tag) ?? [];
    list.push(op);
    byTag.set(op.tag, list);
  }
  return [...byTag.entries()]
    .map(([tag, ops]) => ({ tag, operations: ops }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

export interface OperationInput {
  name: string;
  // Where the value goes when building the request.
  kind: 'path' | 'query' | 'body';
  required: boolean;
  description?: string;
}

// The inputs a caller must supply to invoke an operation: its path params,
// query params, and (for a JSON body) the top-level body field names. Derived
// from the spec so prompts match exactly what the route documents.
export function operationInputs(
  spec: ApiClient,
  method: OperationSummary['method'],
  path: string
): OperationInput[] {
  const pathItem = spec.api.paths[path];
  const op = pathItem?.operations[method];
  if (!op) return [];

  const inputs: OperationInput[] = [];

  const merged = [...pathItem.parameters, ...op.parameters];
  const seen = new Set<string>();
  for (const param of merged) {
    if (param.in !== 'path' && param.in !== 'query') continue;
    const key = `${param.in}:${param.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    inputs.push({
      name: param.name,
      kind: param.in,
      required: param.required,
      ...(param.description !== undefined ? { description: param.description } : {}),
    });
  }

  const jsonBody = op.requestBody?.content['application/json'];
  const bodySchema = jsonBody?.schema.jsonSchema;
  if (bodySchema && typeof bodySchema === 'object') {
    const props = (bodySchema as { properties?: Record<string, unknown> }).properties;
    const required = new Set(
      Array.isArray((bodySchema as { required?: unknown }).required)
        ? (bodySchema as { required: string[] }).required
        : []
    );
    if (props) {
      for (const propName of Object.keys(props)) {
        const prop = props[propName];
        const description =
          prop &&
          typeof prop === 'object' &&
          typeof (prop as { description?: unknown }).description === 'string'
            ? (prop as { description: string }).description
            : undefined;
        inputs.push({
          name: propName,
          kind: 'body',
          required: required.has(propName),
          ...(description !== undefined ? { description } : {}),
        });
      }
    }
  }

  return inputs;
}
