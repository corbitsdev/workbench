import { type } from "arktype";
import type { ToolDefinition } from "@intx/types/runtime";
import { fetchLinearGraphQL } from "./client";
import { parseArgs, requireMutationSuccess, type LinearToolsConfig } from "./shared";

const GET_ATTACHMENT_QUERY = `query GetAttachment($id: String!) {
  attachment(id: $id) {
    id title url metadata
  }
}`;

const FILE_UPLOAD_MUTATION = `mutation FileUpload($filename: String!, $contentType: String!, $size: Int!) {
  fileUpload(filename: $filename, contentType: $contentType, size: $size) {
    success
    uploadFile {
      uploadUrl
      assetUrl
      headers { key value }
    }
  }
}`;

const ATTACHMENT_CREATE = `mutation AttachmentCreate($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) {
    success
    attachment { id url title }
  }
}`;

const GetAttachmentArgsSchema = type({ id: "string > 0" });

const PrepareUploadArgsSchema = type({
  issue: "string > 0",
  filename: "string > 0",
  contentType: "string > 0",
  size: "number > 0",
  "title?": "string",
});

const CreateFromUploadArgsSchema = type({
  issue: "string > 0",
  assetUrl: "string > 0",
  "title?": "string",
  "subtitle?": "string",
});

export async function getAttachment(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(GetAttachmentArgsSchema, rawArgs, "linear_get_attachment");
  const data = await fetchLinearGraphQL(
    config,
    GET_ATTACHMENT_QUERY,
    { id: args.id },
    signal,
  );
  if (data.attachment === null || data.attachment === undefined) {
    throw new Error(`Linear attachment not found: ${args.id}`);
  }
  return data.attachment;
}

export async function prepareAttachmentUpload(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(
    PrepareUploadArgsSchema,
    rawArgs,
    "linear_prepare_attachment_upload",
  );
  const data = await fetchLinearGraphQL(
    config,
    FILE_UPLOAD_MUTATION,
    {
      filename: args.filename,
      contentType: args.contentType,
      size: Math.trunc(args.size),
    },
    signal,
  );
  const upload = data.fileUpload;
  return {
    issue: args.issue,
    title: args.title ?? args.filename,
    ...(typeof upload === "object" && upload !== null ? { upload } : {}),
  };
}

export async function createAttachmentFromUpload(
  config: LinearToolsConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(
    CreateFromUploadArgsSchema,
    rawArgs,
    "linear_create_attachment_from_upload",
  );
  const input: Record<string, unknown> = {
    issueId: args.issue,
    url: args.assetUrl,
    title: args.title ?? args.assetUrl,
  };
  if (args.subtitle !== undefined) input.subtitle = args.subtitle;
  const data = await fetchLinearGraphQL(
    config,
    ATTACHMENT_CREATE,
    { input },
    signal,
  );
  return requireMutationSuccess(data, "attachmentCreate");
}

export const LINEAR_GET_ATTACHMENT_DEFINITION: ToolDefinition = {
  name: "linear_get_attachment",
  description: "Get a Linear attachment by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
};

export const LINEAR_PREPARE_ATTACHMENT_UPLOAD_DEFINITION: ToolDefinition = {
  name: "linear_prepare_attachment_upload",
  description:
    "Prepare a direct file upload (write). Returns signed upload URL; PUT bytes client-side before finalize.",
  inputSchema: {
    type: "object",
    properties: {
      issue: { type: "string" },
      filename: { type: "string" },
      contentType: { type: "string" },
      size: { type: "number" },
      title: { type: "string" },
    },
    required: ["issue", "filename", "contentType", "size"],
  },
};

export const LINEAR_CREATE_ATTACHMENT_FROM_UPLOAD_DEFINITION: ToolDefinition = {
  name: "linear_create_attachment_from_upload",
  description:
    "Link an uploaded asset URL to an issue as an attachment (write).",
  inputSchema: {
    type: "object",
    properties: {
      issue: { type: "string" },
      assetUrl: { type: "string" },
      title: { type: "string" },
      subtitle: { type: "string" },
    },
    required: ["issue", "assetUrl"],
  },
};