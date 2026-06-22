import type { ApiClient } from "@workbench/openapi-arktype";
import type { OperationSummary } from "./client";

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
  kind: "path" | "query" | "body";
  required: boolean;
  description?: string;
  // Allowed values, when the spec schema is an enum — drives an enum picker.
  enumValues?: string[];
  // The JSON-schema primitive type, when known — 'boolean' drives a yes/no
  // picker; 'object'/'array' hint that free-text JSON is expected.
  valueType?: string;
  // The resource (OpenAPI tag) this id field references, when it is a foreign
  // key — drives a list picker so the operator never types a raw id.
  reference?: string;
}

// Foreign-key id fields → the resource (OpenAPI tag) that owns them. Lets the
// CLI offer a list picker for an id instead of asking the operator to paste a
// value they cannot know. `tenantId`/`tenant` are intentionally absent: they are
// prefilled from the up-front tenant selection.
const REFERENCE_TAGS: Record<string, string> = {
  providerId: "Providers",
  principalId: "Principals",
  credentialId: "Credentials",
  oauthClientId: "OAuth Clients",
  roleId: "Roles",
  agentId: "Agents",
  instanceId: "Instances",
  walletId: "Wallets",
  assetId: "Assets",
  deploymentId: "Workflows",
};

export function referenceTagFor(name: string): string | undefined {
  return REFERENCE_TAGS[name];
}

// Pull the guided-prompt facts out of a JSON-schema fragment: its enum values
// (string-coerced) and its primitive type.
function schemaFacts(
  schema: unknown,
): Pick<OperationInput, "enumValues" | "valueType"> {
  if (!schema || typeof schema !== "object") return {};
  const obj = schema as { enum?: unknown; type?: unknown };
  const out: Pick<OperationInput, "enumValues" | "valueType"> = {};
  if (Array.isArray(obj.enum)) {
    out.enumValues = obj.enum.map((v) => String(v));
  }
  if (typeof obj.type === "string") {
    out.valueType = obj.type;
  }
  return out;
}

// Find the collection-list operation for a resource tag: the GET with the
// fewest path params (i.e. the `.../providers` collection, not
// `.../providers/{id}`). Used to populate reference pickers.
export function findListOperation(
  operations: OperationSummary[],
  tag: string,
): OperationSummary | undefined {
  const gets = operations.filter((op) => op.tag === tag && op.method === "get");
  if (gets.length === 0) return undefined;
  const pathParamCount = (path: string) => (path.match(/[:{]/g) ?? []).length;
  return [...gets].sort(
    (a, b) => pathParamCount(a.path) - pathParamCount(b.path),
  )[0];
}

// Normalize a list response to its items + optional next-page cursor. Handles
// both `{ data: [...], nextCursor }` (paginated) and a bare array.
export function extractItems(data: unknown): {
  items: unknown[];
  nextCursor?: string;
} {
  if (Array.isArray(data)) return { items: data };
  if (data && typeof data === "object") {
    const obj = data as { data?: unknown; nextCursor?: unknown };
    const items = Array.isArray(obj.data) ? obj.data : [];
    return typeof obj.nextCursor === "string"
      ? { items, nextCursor: obj.nextCursor }
      : { items };
  }
  return { items: [] };
}

// A human label for a picker row: lead with a readable name (the resource's
// own name, or for an agent instance the agent it runs), then append the most
// useful disambiguators the list response carries — status and a short date —
// so opaque-id resources (instances) are still identifiable at a glance.
export function itemLabel(item: unknown): {
  label: string;
  id: string | undefined;
} {
  if (!item || typeof item !== "object")
    return { label: String(item), id: undefined };
  const obj = item as Record<string, unknown>;
  const id = typeof obj["id"] === "string" ? obj["id"] : undefined;
  const named =
    obj["name"] ??
    obj["agentName"] ??
    obj["email"] ??
    obj["slug"] ??
    obj["title"] ??
    obj["kind"] ??
    id;
  let label =
    id && named !== id
      ? `${String(named)} [${id}]`
      : String(named ?? id ?? "?");

  const extras: string[] = [];
  if (typeof obj["status"] === "string") extras.push(obj["status"]);
  const created = obj["createdAt"];
  if (typeof created === "string" && created.length >= 10) {
    extras.push(created.slice(0, 10));
  }
  if (extras.length > 0) label += ` · ${extras.join(" · ")}`;

  return { label, id };
}

// The inputs a caller must supply to invoke an operation: its path params,
// query params, and (for a JSON body) the top-level body field names. Derived
// from the spec so prompts match exactly what the route documents.
export function operationInputs(
  spec: ApiClient,
  method: OperationSummary["method"],
  path: string,
): OperationInput[] {
  const pathItem = spec.api.paths[path];
  const op = pathItem?.operations[method];
  if (!op) return [];

  const inputs: OperationInput[] = [];

  const merged = [...pathItem.parameters, ...op.parameters];
  const seen = new Set<string>();
  for (const param of merged) {
    if (param.in !== "path" && param.in !== "query") continue;
    const key = `${param.in}:${param.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const facts = schemaFacts(param.schema.jsonSchema);
    const reference = referenceTagFor(param.name);
    inputs.push({
      name: param.name,
      kind: param.in,
      required: param.required,
      ...(param.description !== undefined
        ? { description: param.description }
        : {}),
      ...(facts.enumValues ? { enumValues: facts.enumValues } : {}),
      ...(facts.valueType ? { valueType: facts.valueType } : {}),
      ...(reference !== undefined ? { reference } : {}),
    });
  }

  const jsonBody = op.requestBody?.content["application/json"];
  const bodySchema = jsonBody?.schema.jsonSchema;
  if (bodySchema && typeof bodySchema === "object") {
    const props = (bodySchema as { properties?: Record<string, unknown> })
      .properties;
    const required = new Set(
      Array.isArray((bodySchema as { required?: unknown }).required)
        ? (bodySchema as { required: string[] }).required
        : [],
    );
    if (props) {
      for (const propName of Object.keys(props)) {
        const prop = props[propName];
        const description =
          prop &&
          typeof prop === "object" &&
          typeof (prop as { description?: unknown }).description === "string"
            ? (prop as { description: string }).description
            : undefined;
        const facts = schemaFacts(prop);
        const reference = referenceTagFor(propName);
        inputs.push({
          name: propName,
          kind: "body",
          required: required.has(propName),
          ...(description !== undefined ? { description } : {}),
          ...(facts.enumValues ? { enumValues: facts.enumValues } : {}),
          ...(facts.valueType ? { valueType: facts.valueType } : {}),
          ...(reference !== undefined ? { reference } : {}),
        });
      }
    }
  }

  return inputs;
}
