import { scope } from "arktype"

// Arktype validators for the OpenAPI 3.1 spec structure (post-dereference).
// We only model the parts we consume — not the full spec.

const oasScope = scope({
  jsonSchema: "Record<string, unknown>",

  mediaType: {
    "schema?": "jsonSchema",
  },

  parameter: {
    name: "string",
    in: "'query' | 'header' | 'path' | 'cookie'",
    "required?": "boolean",
    "description?": "string",
    "schema?": "jsonSchema",
    "deprecated?": "boolean",
  },

  requestBody: {
    "required?": "boolean",
    "description?": "string",
    "content?": "Record<string, mediaType>",
  },

  header: {
    "schema?": "jsonSchema",
    "description?": "string",
    "required?": "boolean",
    "deprecated?": "boolean",
  },

  response: {
    description: "string",
    "content?": "Record<string, mediaType>",
    "headers?": "Record<string, header>",
  },

  operation: {
    "operationId?": "string",
    "summary?": "string",
    "description?": "string",
    "tags?": "string[]",
    "deprecated?": "boolean",
    "parameters?": "parameter[]",
    "requestBody?": "requestBody",
    "responses?": "Record<string, response>",
  },

  pathItem: {
    "parameters?": "parameter[]",
    "get?": "operation",
    "post?": "operation",
    "put?": "operation",
    "delete?": "operation",
    "patch?": "operation",
    "head?": "operation",
    "options?": "operation",
    "trace?": "operation",
  },

  server: {
    url: "string",
    "description?": "string",
  },

  info: {
    title: "string",
    version: "string",
    "description?": "string",
  },

  components: {
    "schemas?": "Record<string, jsonSchema>",
  },

  openApiSpec: {
    openapi: "string",
    info: "info",
    "servers?": "server[]",
    "paths?": "Record<string, pathItem>",
    "components?": "components",
  },
})

export const oasTypes = oasScope.export()

export type OASSpec = typeof oasTypes.openApiSpec.infer
export type OASPathItem = typeof oasTypes.pathItem.infer
export type OASOperation = typeof oasTypes.operation.infer
export type OASParameter = typeof oasTypes.parameter.infer
export type OASRequestBody = typeof oasTypes.requestBody.infer
export type OASResponse = typeof oasTypes.response.infer
export type OASMediaType = typeof oasTypes.mediaType.infer
export type OASInfo = typeof oasTypes.info.infer
export type OASServer = typeof oasTypes.server.infer
export type OASComponents = typeof oasTypes.components.infer
export type OASHeader = typeof oasTypes.header.infer
export type JSONSchema = typeof oasTypes.jsonSchema.infer
