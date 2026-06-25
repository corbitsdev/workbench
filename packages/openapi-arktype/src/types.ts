import type { Type } from "arktype";

export type HttpMethod =
  | "get"
  | "post"
  | "put"
  | "delete"
  | "patch"
  | "head"
  | "options"
  | "trace";

export const HTTP_METHODS: HttpMethod[] = [
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
];

export interface CreateClientOptions {
  spec?: string | Record<string, unknown>;
  url?: string;
  path?: string;
}

export interface ApiClient {
  api: ApiDescription;
  schemas: Record<string, Type<unknown>>;
  operation(method: HttpMethod, path: string): OperationValidators | undefined;
  diagnostics: Diagnostic[];
}

export interface ApiDescription {
  title: string;
  version: string;
  description?: string;
  servers: ServerEntry[];
  paths: Record<string, PathItem>;
  schemas: Record<string, SchemaEntry>;
}

export interface ServerEntry {
  url: string;
  description?: string;
}

export interface PathItem {
  path: string;
  parameters: ParameterEntry[];
  operations: Partial<Record<HttpMethod, Operation>>;
}

export interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags: string[];
  deprecated: boolean;
  parameters: ParameterEntry[];
  requestBody?: RequestBodyEntry;
  responses: Record<string, ResponseEntry>;
}

export interface ParameterEntry {
  name: string;
  in: "query" | "header" | "path" | "cookie";
  required: boolean;
  description?: string;
  schema: SchemaEntry;
}

export interface SchemaEntry {
  name?: string;
  jsonSchema: Record<string, unknown>;
  validator: Type<unknown>;
  metadata: SchemaMetadata;
}

export interface SchemaMetadata {
  readOnly?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;
  default?: unknown;
  example?: unknown;
  extensions: Record<string, unknown>;
}

export interface RequestBodyEntry {
  required: boolean;
  description?: string;
  content: Record<string, MediaTypeEntry>;
}

export interface MediaTypeEntry {
  schema: SchemaEntry;
}

export interface ResponseEntry {
  description: string;
  content: Record<string, MediaTypeEntry>;
  headers: Record<string, SchemaEntry>;
}

export interface OperationValidators {
  pathParams?: Type<unknown>;
  queryParams?: Type<unknown>;
  headerParams?: Type<unknown>;
  requestBody?: Record<string, Type<unknown>>;
  responses: Record<string, Record<string, Type<unknown>>>;
}

export interface Diagnostic {
  level: "warn" | "info";
  path: string[];
  message: string;
  code: DiagnosticCode;
}

export type DiagnosticCode =
  | "UNSUPPORTED_FORMAT"
  | "STRIPPED_DISCRIMINATOR"
  | "STRIPPED_KEYWORD"
  | "SCHEMA_CONVERSION_ERROR";

export class OpenApiArktypeError extends Error {
  code: "LOAD_FAILED" | "PARSE_FAILED" | "DEREFERENCE_FAILED" | "INVALID_SPEC";
  details?: unknown;

  constructor(
    code: OpenApiArktypeError["code"],
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "OpenApiArktypeError";
    this.code = code;
    this.details = details;
  }
}
