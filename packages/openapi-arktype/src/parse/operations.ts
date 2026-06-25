import { type, type Type } from "arktype";
import type {
  ApiDescription,
  Diagnostic,
  HttpMethod,
  MediaTypeEntry,
  Operation,
  OperationValidators,
  ParameterEntry,
  PathItem,
  RequestBodyEntry,
  ResponseEntry,
  SchemaEntry,
  ServerEntry,
} from "../types.js";
import { HTTP_METHODS } from "../types.js";
import type {
  OASSpec,
  OASPathItem,
  OASOperation,
  OASParameter,
  OASRequestBody,
  OASResponse,
  OASMediaType,
  OASHeader,
} from "./spec-types.js";
import { convertSchema } from "./schema.js";

export function buildApiDescription(
  spec: OASSpec,
  diagnostics: Diagnostic[],
): ApiDescription {
  return {
    title: spec.info.title,
    version: spec.info.version,
    description: spec.info.description,
    servers: buildServers(spec),
    paths: buildPaths(spec, diagnostics),
    schemas: buildComponentSchemas(spec, diagnostics),
  };
}

function buildServers(spec: OASSpec): ServerEntry[] {
  if (!spec.servers) return [];
  return spec.servers.map((s) => ({
    url: s.url,
    description: s.description,
  }));
}

function buildComponentSchemas(
  spec: OASSpec,
  diagnostics: Diagnostic[],
): Record<string, SchemaEntry> {
  const schemasObj = spec.components?.schemas;
  if (!schemasObj) return {};

  const result: Record<string, SchemaEntry> = {};
  for (const [name, schema] of Object.entries(schemasObj)) {
    result[name] = convertSchema(
      schema,
      diagnostics,
      ["components", "schemas", name],
      name,
    );
  }
  return result;
}

function buildPaths(
  spec: OASSpec,
  diagnostics: Diagnostic[],
): Record<string, PathItem> {
  if (!spec.paths) return {};

  const result: Record<string, PathItem> = {};
  for (const [pathStr, pathObj] of Object.entries(spec.paths)) {
    result[pathStr] = buildPathItem(pathStr, pathObj, diagnostics);
  }
  return result;
}

function buildPathItem(
  path: string,
  pathObj: OASPathItem,
  diagnostics: Diagnostic[],
): PathItem {
  const pathParams = buildParameters(pathObj.parameters, diagnostics, [
    "paths",
    path,
    "parameters",
  ]);

  const operations: Partial<Record<HttpMethod, Operation>> = {};
  for (const method of HTTP_METHODS) {
    const opObj = pathObj[method];
    if (!opObj) continue;

    operations[method] = buildOperation(opObj, diagnostics, [
      "paths",
      path,
      method,
    ]);
  }

  return { path, parameters: pathParams, operations };
}

function buildOperation(
  opObj: OASOperation,
  diagnostics: Diagnostic[],
  basePath: string[],
): Operation {
  return {
    operationId: opObj.operationId,
    summary: opObj.summary,
    description: opObj.description,
    tags: opObj.tags ?? [],
    deprecated: opObj.deprecated ?? false,
    parameters: buildParameters(opObj.parameters, diagnostics, [
      ...basePath,
      "parameters",
    ]),
    requestBody: buildRequestBody(opObj.requestBody, diagnostics, [
      ...basePath,
      "requestBody",
    ]),
    responses: buildResponses(opObj.responses, diagnostics, [
      ...basePath,
      "responses",
    ]),
  };
}

function buildParameters(
  params: OASParameter[] | undefined,
  diagnostics: Diagnostic[],
  basePath: string[],
): ParameterEntry[] {
  if (!params) return [];

  return params.map((p, i) => {
    const schemaPath = [...basePath, String(i), "schema"];
    return {
      name: p.name,
      in: p.in,
      required: p.required ?? false,
      description: p.description,
      schema: p.schema
        ? convertSchema(p.schema, diagnostics, schemaPath)
        : convertSchema({ type: "string" }, diagnostics, schemaPath),
    };
  });
}

function buildRequestBody(
  body: OASRequestBody | undefined,
  diagnostics: Diagnostic[],
  basePath: string[],
): RequestBodyEntry | undefined {
  if (!body) return undefined;

  return {
    required: body.required ?? false,
    description: body.description,
    content: buildContent(body.content, diagnostics, [...basePath, "content"]),
  };
}

function buildResponses(
  responses: Record<string, OASResponse> | undefined,
  diagnostics: Diagnostic[],
  basePath: string[],
): Record<string, ResponseEntry> {
  if (!responses) return {};

  const result: Record<string, ResponseEntry> = {};
  for (const [status, respObj] of Object.entries(responses)) {
    result[status] = {
      description: respObj.description,
      content: buildContent(respObj.content, diagnostics, [
        ...basePath,
        status,
        "content",
      ]),
      headers: buildHeaderSchemas(respObj.headers, diagnostics, [
        ...basePath,
        status,
        "headers",
      ]),
    };
  }
  return result;
}

function buildContent(
  content: Record<string, OASMediaType> | undefined,
  diagnostics: Diagnostic[],
  basePath: string[],
): Record<string, MediaTypeEntry> {
  if (!content) return {};

  const result: Record<string, MediaTypeEntry> = {};
  for (const [mediaType, mtObj] of Object.entries(content)) {
    if (mtObj.schema) {
      result[mediaType] = {
        schema: convertSchema(mtObj.schema, diagnostics, [
          ...basePath,
          mediaType,
          "schema",
        ]),
      };
    }
  }
  return result;
}

function buildHeaderSchemas(
  headers: Record<string, OASHeader> | undefined,
  diagnostics: Diagnostic[],
  basePath: string[],
): Record<string, SchemaEntry> {
  if (!headers) return {};

  const result: Record<string, SchemaEntry> = {};
  for (const [headerName, headerObj] of Object.entries(headers)) {
    if (headerObj.schema) {
      result[headerName] = convertSchema(headerObj.schema, diagnostics, [
        ...basePath,
        headerName,
        "schema",
      ]);
    }
  }
  return result;
}

export function buildOperationValidators(
  operation: Operation,
): OperationValidators {
  const result: OperationValidators = {
    responses: {},
  };

  const pathParams = operation.parameters.filter((p) => p.in === "path");
  const queryParams = operation.parameters.filter((p) => p.in === "query");
  const headerParams = operation.parameters.filter((p) => p.in === "header");

  if (pathParams.length > 0) {
    result.pathParams = paramsToObjectType(pathParams);
  }
  if (queryParams.length > 0) {
    result.queryParams = paramsToObjectType(queryParams);
  }
  if (headerParams.length > 0) {
    result.headerParams = paramsToObjectType(headerParams);
  }

  if (operation.requestBody) {
    result.requestBody = {};
    for (const [mediaType, entry] of Object.entries(
      operation.requestBody.content,
    )) {
      result.requestBody[mediaType] = entry.schema.validator;
    }
  }

  for (const [status, response] of Object.entries(operation.responses)) {
    result.responses[status] = {};
    for (const [mediaType, entry] of Object.entries(response.content)) {
      result.responses[status][mediaType] = entry.schema.validator;
    }
  }

  return result;
}

function paramsToObjectType(params: ParameterEntry[]): Type<unknown> {
  const props: Record<string, Type<unknown>> = {};
  for (const param of params) {
    const key = param.required ? param.name : `${param.name}?`;
    props[key] = param.schema.validator;
  }
  return type(props as never) as Type<unknown>;
}
