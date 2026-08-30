// The Manus tool bundle: an agent-facing wrapper around `./client.ts`
// that never throws. A missing credential or a failed call both come
// back as a completed `ToolResult` with `isError: true`.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { CredentialCapability } from "@intx/types";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import {
  buildTaskMessage,
  createSlideDeck,
  createTask,
  getTaskDetail,
  listTaskMessages,
  manusRequest,
  type ManusClientConfig,
  type ManusHttpMethod,
} from "./client";

/** The handle this package declares in `interchange.credentials`. */
export const MANUS_CREDENTIAL_HANDLE = "manus";

export const MANUS_NOT_CONNECTED = "Manus is not connected for this user.";

export const CREATE_SLIDES_TOOL = "create_slides";

type JsonSchemaProperty = {
  readonly type: string;
  readonly description: string;
  readonly items?: { readonly type: string };
};

type EndpointSpec = {
  readonly name: string;
  readonly method: ManusHttpMethod;
  readonly path: string;
  readonly description: string;
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, JsonSchemaProperty>>;
  readonly approval?: "ask";
};

const STRING = (description: string): JsonSchemaProperty => ({
  type: "string",
  description,
});
const NUMBER = (description: string): JsonSchemaProperty => ({
  type: "number",
  description,
});
const BOOLEAN = (description: string): JsonSchemaProperty => ({
  type: "boolean",
  description,
});
const OBJECT = (description: string): JsonSchemaProperty => ({
  type: "object",
  description,
});
const STRING_ARRAY = (description: string): JsonSchemaProperty => ({
  type: "array",
  description,
  items: { type: "string" },
});

const MESSAGE_SKILL_PROPERTIES = {
  enable_skills: STRING_ARRAY(
    "Skill ids from skill_list to make available. If omitted, the account default skills are used.",
  ),
  force_skills: STRING_ARRAY(
    "Skill ids the agent must invoke. Forced skills are available even when not listed in enable_skills.",
  ),
  connectors: STRING_ARRAY(
    "Connector ids from connector_list to attach to this message.",
  ),
  task_references: STRING_ARRAY(
    "Task ids (up to 20) the agent may browse. Pass the 22-character id, not a URL.",
  ),
} as const;

export const MANUS_ENDPOINTS: readonly EndpointSpec[] = [
  {
    name: "task_create",
    method: "POST",
    path: "/v2/task.create",
    description:
      "Creates a Manus task. Pass content as the prompt text (sent as message.content ContentPart text). Poll task_list_msgs for progress. Pass skill ids from skill_list via enable_skills or force_skills.",
    required: ["content"],
    properties: {
      content: STRING("Prompt text that starts the task."),
      title: STRING("Optional custom task title."),
      project_id: STRING("Project to associate this task with."),
      locale: STRING("Output locale, e.g. en or zh-CN."),
      interactive_mode: BOOLEAN(
        "When true, the agent may pause to ask questions.",
      ),
      hide_in_task_list: BOOLEAN(
        "When true, hide the task from the Manus task list.",
      ),
      share_visibility: STRING("private, team, or public."),
      agent_profile: STRING(
        "Defaults to manus-1.6-lite. Other values: manus-1.6, manus-1.6-max.",
      ),
      ...MESSAGE_SKILL_PROPERTIES,
      structured_output_schema: OBJECT(
        "JSON Schema for structured output extraction. Sent on the create body, not inside message.",
      ),
    },
  },
  {
    name: "task_detail",
    method: "GET",
    path: "/v2/task.detail",
    description: "Fetches one Manus task by task_id.",
    required: ["task_id"],
    properties: { task_id: STRING("Task id.") },
  },
  {
    name: "task_list",
    method: "GET",
    path: "/v2/task.list",
    description: "Lists Manus tasks.",
    required: [],
    properties: {
      limit: NUMBER("Page size."),
      cursor: STRING("Pagination cursor."),
      order: STRING("Sort order."),
      scope: STRING("List scope."),
      agent_id: STRING("Filter by agent id."),
      project_id: STRING("Filter by project id."),
    },
  },
  {
    name: "task_update",
    method: "POST",
    path: "/v2/task.update",
    description:
      "Updates a Manus task's title, visibility, or list visibility.",
    required: ["task_id"],
    properties: {
      task_id: STRING("Task id."),
      title: STRING("New title."),
      share_visibility: STRING("private, team, or public."),
      enable_visible_in_task_list: BOOLEAN(
        "Show the task in the Manus task list.",
      ),
    },
  },
  {
    name: "task_stop",
    method: "POST",
    path: "/v2/task.stop",
    description: "Stops a running Manus task.",
    required: ["task_id"],
    properties: { task_id: STRING("Task id.") },
  },
  {
    name: "task_delete",
    method: "POST",
    path: "/v2/task.delete",
    description: "Deletes a Manus task.",
    required: ["task_id"],
    properties: { task_id: STRING("Task id.") },
    approval: "ask",
  },
  {
    name: "task_send_msg",
    method: "POST",
    path: "/v2/task.sendMessage",
    description:
      "Sends a follow-up message to an existing Manus task. Pass skill ids from skill_list via enable_skills or force_skills.",
    required: ["task_id", "content"],
    properties: {
      task_id: STRING("Task id."),
      content: STRING(
        "Follow-up prompt text (sent as message.content ContentPart text).",
      ),
      agent_profile: STRING("Optional agent profile override."),
      ...MESSAGE_SKILL_PROPERTIES,
    },
  },
  {
    name: "task_list_msgs",
    method: "GET",
    path: "/v2/task.listMessages",
    description:
      "Lists messages and status events for a Manus task. Poll until agent_status is stopped. Output files appear as assistant_message attachments.",
    required: ["task_id"],
    properties: {
      task_id: STRING("Task id."),
      limit: NUMBER("Page size."),
      cursor: STRING("Pagination cursor."),
      order: STRING("Sort order."),
      verbose: BOOLEAN("Include tool/plan events."),
      slides_format: STRING("Preferred slides download format: pptx or html."),
    },
  },
  {
    name: "task_confirm",
    method: "POST",
    path: "/v2/task.confirmAction",
    description:
      "Confirms a waiting Manus task action (event_id from a waiting status).",
    required: ["task_id", "event_id"],
    properties: {
      task_id: STRING("Task id."),
      event_id: STRING("Waiting event id."),
      input: OBJECT("Optional confirmation input object."),
    },
  },
  {
    name: "project_create",
    method: "POST",
    path: "/v2/project.create",
    description: "Creates a Manus project.",
    required: ["name"],
    properties: {
      name: STRING("Project name."),
      instruction: STRING("Optional project instruction."),
    },
  },
  {
    name: "project_list",
    method: "GET",
    path: "/v2/project.list",
    description: "Lists Manus projects.",
    required: [],
    properties: {},
  },
  {
    name: "skill_list",
    method: "GET",
    path: "/v2/skill.list",
    description: "Lists available Manus skills.",
    required: [],
    properties: { project_id: STRING("Optional project id to scope skills.") },
  },
  {
    name: "agent_list",
    method: "GET",
    path: "/v2/agent.list",
    description: "Lists Manus agents.",
    required: [],
    properties: {},
  },
  {
    name: "agent_detail",
    method: "GET",
    path: "/v2/agent.detail",
    description: "Fetches one Manus agent by agent_id.",
    required: ["agent_id"],
    properties: { agent_id: STRING("Agent id.") },
  },
  {
    name: "agent_update",
    method: "POST",
    path: "/v2/agent.update",
    description: "Updates a Manus agent's nickname or about text.",
    required: ["agent_id"],
    properties: {
      agent_id: STRING("Agent id."),
      nickname: STRING("New nickname."),
      about: STRING("New about text."),
    },
  },
  {
    name: "file_upload",
    method: "POST",
    path: "/v2/file.upload",
    description:
      "Creates a pending Manus file and returns a presigned upload_url. PUT the file bytes to that URL before it expires.",
    required: ["filename"],
    properties: { filename: STRING("File name to upload.") },
  },
  {
    name: "file_detail",
    method: "GET",
    path: "/v2/file.detail",
    description: "Fetches one Manus file by file_id.",
    required: ["file_id"],
    properties: { file_id: STRING("File id.") },
  },
  {
    name: "file_delete",
    method: "POST",
    path: "/v2/file.delete",
    description: "Deletes a Manus file.",
    required: ["file_id"],
    properties: { file_id: STRING("File id.") },
    approval: "ask",
  },
  {
    name: "webhook_create",
    method: "POST",
    path: "/v2/webhook.create",
    description: "Creates a Manus webhook.",
    required: ["url"],
    properties: { url: STRING("Webhook callback URL.") },
    approval: "ask",
  },
  {
    name: "webhook_list",
    method: "GET",
    path: "/v2/webhook.list",
    description: "Lists Manus webhooks.",
    required: [],
    properties: {},
    approval: "ask",
  },
  {
    name: "webhook_delete",
    method: "POST",
    path: "/v2/webhook.delete",
    description: "Deletes a Manus webhook.",
    required: ["webhook_id"],
    properties: { webhook_id: STRING("Webhook id.") },
    approval: "ask",
  },
  {
    name: "webhook_pubkey",
    method: "GET",
    path: "/v2/webhook.publicKey",
    description: "Returns the Manus webhook signing public key.",
    required: [],
    properties: {},
    approval: "ask",
  },
  {
    name: "usage_list",
    method: "GET",
    path: "/v2/usage.list",
    description: "Lists Manus usage records.",
    required: [],
    properties: {
      limit: NUMBER("Page size."),
      cursor: STRING("Pagination cursor."),
    },
  },
  {
    name: "usage_credits",
    method: "GET",
    path: "/v2/usage.availableCredits",
    description: "Returns available Manus credits.",
    required: [],
    properties: {},
  },
  {
    name: "usage_team_stat",
    method: "GET",
    path: "/v2/usage.teamStatistic",
    description: "Returns Manus team usage statistics.",
    required: [],
    properties: {
      start_date: NUMBER("Start date as a unix timestamp."),
      end_date: NUMBER("End date as a unix timestamp."),
    },
  },
  {
    name: "usage_team_log",
    method: "GET",
    path: "/v2/usage.teamLog",
    description: "Returns the Manus team usage log.",
    required: [],
    properties: {
      limit: NUMBER("Page size."),
      cursor: STRING("Pagination cursor."),
      start_date: NUMBER("Start date as a unix timestamp."),
      end_date: NUMBER("End date as a unix timestamp."),
      sort_by: STRING("Sort field."),
      is_asc: BOOLEAN("Sort ascending when true."),
    },
  },
  {
    name: "connector_list",
    method: "GET",
    path: "/v2/connector.list",
    description: "Lists Manus connectors available to this account.",
    required: [],
    properties: {},
  },
  {
    name: "browser_online",
    method: "GET",
    path: "/v2/browser.onlineList",
    description: "Lists online Manus browser clients.",
    required: [],
    properties: {},
  },
  {
    name: "website_status",
    method: "GET",
    path: "/v2/website.status",
    description: "Returns Manus website publish status for a task or website.",
    required: [],
    properties: {
      task_id: STRING("Task id."),
      website_id: STRING("Website id."),
    },
  },
  {
    name: "website_publish",
    method: "POST",
    path: "/v2/website.publish",
    description: "Publishes a Manus website.",
    required: [],
    properties: {
      task_id: STRING("Task id."),
      website_id: STRING("Website id."),
      visibility: STRING("Visibility."),
    },
    approval: "ask",
  },
  {
    name: "website_update",
    method: "POST",
    path: "/v2/website.update",
    description: "Updates a Manus website title or visibility.",
    required: [],
    properties: {
      task_id: STRING("Task id."),
      website_id: STRING("Website id."),
      title: STRING("New title."),
      visibility: STRING("Visibility."),
    },
    approval: "ask",
  },
  {
    name: "website_ckpts",
    method: "GET",
    path: "/v2/website.listCheckpoints",
    description: "Lists Manus website checkpoints.",
    required: [],
    properties: {
      task_id: STRING("Task id."),
      website_id: STRING("Website id."),
    },
  },
];

export interface ManusEnv extends BaseEnv {
  readonly credentials?: CredentialCapability;
}

function notConnectedResult(callId: string): ToolResult {
  return {
    callId,
    content: MANUS_NOT_CONNECTED,
    isError: true,
  };
}

async function resolveManusCredential(
  env: ManusEnv,
): Promise<{ fetchImpl: typeof fetch } | null> {
  if (env.credentials === undefined) return null;
  try {
    const mediated = await env.credentials.resolve(MANUS_CREDENTIAL_HANDLE);
    return { fetchImpl: mediated.fetch as unknown as typeof fetch };
  } catch {
    return null;
  }
}

function asClientConfig(credential: {
  fetchImpl: typeof fetch;
}): ManusClientConfig {
  return { fetchImpl: credential.fetchImpl };
}

function stringArg(call: ToolCall, key: string): string | undefined {
  const value = call.arguments[key];
  return typeof value === "string" ? value : undefined;
}

function pickParams(
  call: ToolCall,
  keys: readonly string[],
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const key of keys) {
    const value = call.arguments[key];
    if (value !== undefined) params[key] = value;
  }
  return params;
}

function missingRequired(
  call: ToolCall,
  required: readonly string[],
): string | undefined {
  for (const key of required) {
    const value = call.arguments[key];
    if (value === undefined || value === "") return key;
  }
  return undefined;
}

function errorResult(callId: string, err: unknown): ToolResult {
  return {
    callId,
    content: err instanceof Error ? err.message : String(err),
    isError: true,
  };
}

async function runEndpoint(
  env: ManusEnv,
  call: ToolCall,
  spec: EndpointSpec,
): Promise<ToolResult> {
  const credential = await resolveManusCredential(env);
  if (credential === null) return notConnectedResult(call.id);
  const missing = missingRequired(call, spec.required);
  if (missing !== undefined) {
    return {
      callId: call.id,
      content: `${spec.name} requires a non-empty ${missing} argument`,
      isError: true,
    };
  }
  const params = pickParams(call, Object.keys(spec.properties));
  if (spec.name === "task_create") {
    const content = stringArg(call, "content");
    if (content === undefined || content === "") {
      return {
        callId: call.id,
        content: "task_create requires a non-empty content argument",
        isError: true,
      };
    }
    try {
      const created = await createTask(asClientConfig(credential), {
        content,
        ...optionalCreateFields(call),
      });
      return { callId: call.id, content: JSON.stringify(created) };
    } catch (err) {
      return errorResult(call.id, err);
    }
  }
  if (spec.name === "task_detail") {
    const taskId = stringArg(call, "task_id");
    if (taskId === undefined || taskId === "") {
      return {
        callId: call.id,
        content: "task_detail requires a non-empty task_id argument",
        isError: true,
      };
    }
    try {
      const detail = await getTaskDetail(asClientConfig(credential), taskId);
      return { callId: call.id, content: JSON.stringify(detail) };
    } catch (err) {
      return errorResult(call.id, err);
    }
  }
  if (spec.name === "task_send_msg") {
    const content = stringArg(call, "content");
    const taskId = stringArg(call, "task_id");
    if (content === undefined || taskId === undefined) {
      return {
        callId: call.id,
        content: "task_send_msg requires task_id and content",
        isError: true,
      };
    }
    const body: Record<string, unknown> = {
      task_id: taskId,
      message: buildTaskMessage(content, messageSkillFields(call)),
    };
    const profile = stringArg(call, "agent_profile");
    if (profile !== undefined) body["agent_profile"] = profile;
    try {
      const result = await manusRequest(asClientConfig(credential), {
        method: spec.method,
        path: spec.path,
        params: body,
      });
      return { callId: call.id, content: JSON.stringify(result) };
    } catch (err) {
      return errorResult(call.id, err);
    }
  }
  if (spec.name === "task_list_msgs") {
    const taskId = stringArg(call, "task_id");
    if (taskId === undefined || taskId === "") {
      return {
        callId: call.id,
        content: "task_list_msgs requires a non-empty task_id argument",
        isError: true,
      };
    }
    try {
      const listed = await listTaskMessages(asClientConfig(credential), {
        task_id: taskId,
        ...optionalListMessageFields(call),
      });
      return { callId: call.id, content: JSON.stringify(listed) };
    } catch (err) {
      return errorResult(call.id, err);
    }
  }
  try {
    const result = await manusRequest(asClientConfig(credential), {
      method: spec.method,
      path: spec.path,
      params,
    });
    return { callId: call.id, content: JSON.stringify(result) };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

function optionalCreateFields(call: ToolCall): {
  title?: string;
  project_id?: string;
  locale?: string;
  interactive_mode?: boolean;
  hide_in_task_list?: boolean;
  share_visibility?: string;
  agent_profile?: string;
  enable_skills?: readonly string[];
  force_skills?: readonly string[];
  connectors?: readonly string[];
  task_references?: readonly string[];
  structured_output_schema?: Readonly<Record<string, unknown>>;
} {
  const fields: {
    title?: string;
    project_id?: string;
    locale?: string;
    interactive_mode?: boolean;
    hide_in_task_list?: boolean;
    share_visibility?: string;
    agent_profile?: string;
    enable_skills?: readonly string[];
    force_skills?: readonly string[];
    connectors?: readonly string[];
    task_references?: readonly string[];
    structured_output_schema?: Readonly<Record<string, unknown>>;
  } = {};
  const title = stringArg(call, "title");
  if (title !== undefined) fields.title = title;
  const projectId = stringArg(call, "project_id");
  if (projectId !== undefined) fields.project_id = projectId;
  const locale = stringArg(call, "locale");
  if (locale !== undefined) fields.locale = locale;
  if (typeof call.arguments["interactive_mode"] === "boolean") {
    fields.interactive_mode = call.arguments["interactive_mode"];
  }
  if (typeof call.arguments["hide_in_task_list"] === "boolean") {
    fields.hide_in_task_list = call.arguments["hide_in_task_list"];
  }
  const visibility = stringArg(call, "share_visibility");
  if (visibility !== undefined) fields.share_visibility = visibility;
  const profile = stringArg(call, "agent_profile");
  if (profile !== undefined) fields.agent_profile = profile;
  const skills = messageSkillFields(call);
  if (skills.enable_skills !== undefined) {
    fields.enable_skills = skills.enable_skills;
  }
  if (skills.force_skills !== undefined) {
    fields.force_skills = skills.force_skills;
  }
  if (skills.connectors !== undefined) {
    fields.connectors = skills.connectors;
  }
  if (skills.task_references !== undefined) {
    fields.task_references = skills.task_references;
  }
  const schema = objectArg(call, "structured_output_schema");
  if (schema !== undefined) fields.structured_output_schema = schema;
  return fields;
}

function stringArrayArg(
  call: ToolCall,
  key: string,
): readonly string[] | undefined {
  const value = call.arguments[key];
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === "string")) return undefined;
  return value;
}

function objectArg(
  call: ToolCall,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const value = call.arguments[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    record[field] = fieldValue;
  }
  return record;
}

function messageSkillFields(call: ToolCall): {
  enable_skills?: readonly string[];
  force_skills?: readonly string[];
  connectors?: readonly string[];
  task_references?: readonly string[];
} {
  const fields: {
    enable_skills?: readonly string[];
    force_skills?: readonly string[];
    connectors?: readonly string[];
    task_references?: readonly string[];
  } = {};
  const enableSkills = stringArrayArg(call, "enable_skills");
  if (enableSkills !== undefined) fields.enable_skills = enableSkills;
  const forceSkills = stringArrayArg(call, "force_skills");
  if (forceSkills !== undefined) fields.force_skills = forceSkills;
  const connectors = stringArrayArg(call, "connectors");
  if (connectors !== undefined) fields.connectors = connectors;
  const taskReferences = stringArrayArg(call, "task_references");
  if (taskReferences !== undefined) fields.task_references = taskReferences;
  return fields;
}

function optionalListMessageFields(call: ToolCall): {
  limit?: number;
  cursor?: string;
  order?: string;
  verbose?: boolean;
  slides_format?: string;
} {
  const fields: {
    limit?: number;
    cursor?: string;
    order?: string;
    verbose?: boolean;
    slides_format?: string;
  } = {};
  if (typeof call.arguments["limit"] === "number") {
    fields.limit = call.arguments["limit"];
  }
  const cursor = stringArg(call, "cursor");
  if (cursor !== undefined) fields.cursor = cursor;
  const order = stringArg(call, "order");
  if (order !== undefined) fields.order = order;
  if (typeof call.arguments["verbose"] === "boolean") {
    fields.verbose = call.arguments["verbose"];
  }
  const slidesFormat = stringArg(call, "slides_format");
  if (slidesFormat !== undefined) fields.slides_format = slidesFormat;
  return fields;
}

async function runCreateSlides(
  env: ManusEnv,
  call: ToolCall,
  signal: AbortSignal,
): Promise<ToolResult> {
  const credential = await resolveManusCredential(env);
  if (credential === null) return notConnectedResult(call.id);
  const prompt = stringArg(call, "prompt");
  if (prompt === undefined || prompt === "") {
    return {
      callId: call.id,
      content: `${CREATE_SLIDES_TOOL} requires a non-empty prompt argument`,
      isError: true,
    };
  }
  const title = stringArg(call, "title");
  try {
    const result = await createSlideDeck(asClientConfig(credential), {
      content: prompt,
      ...(title !== undefined ? { title } : {}),
      signal,
    });
    return { callId: call.id, content: JSON.stringify(result) };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

const CREATE_SLIDES_DEFINITION = {
  name: CREATE_SLIDES_TOOL,
  description:
    "Creates a Manus task that produces a slide deck from a prompt, waits until the agent stops, and returns output files (filename, url, id) so they can be retrieved.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "What the slide deck should cover.",
      },
      title: {
        type: "string",
        description: "Optional task title.",
      },
    },
    required: ["prompt"],
  },
} as const;

/**
 * The `@corbits/manus-tools` bundle factory. The bundle id's local
 * segment is kept short — the wire encoding of `<id>:<tool name>` must
 * fit the 64-char OpenAI function-name cap.
 */
export const manusTools = defineTool<ManusEnv>({
  id: "@corbits/manus-tools/mn",
  requires: ["credentials"],
  definitions: [
    { name: CREATE_SLIDES_TOOL },
    ...MANUS_ENDPOINTS.map((spec) =>
      spec.approval === "ask"
        ? { name: spec.name, approval: "ask" as const }
        : { name: spec.name },
    ),
  ],
  factory: (env) => ({
    definitions: [
      CREATE_SLIDES_DEFINITION,
      ...MANUS_ENDPOINTS.map((spec) => ({
        name: spec.name,
        description: spec.description,
        inputSchema: {
          type: "object",
          properties: spec.properties,
          ...(spec.required.length > 0 ? { required: [...spec.required] } : {}),
        },
      })),
    ],
    run: (call, signal) => {
      if (call.name === CREATE_SLIDES_TOOL) {
        return runCreateSlides(env, call, signal);
      }
      const spec = MANUS_ENDPOINTS.find((entry) => entry.name === call.name);
      if (spec === undefined) {
        return Promise.resolve({
          callId: call.id,
          content: `Unknown Manus tool: ${call.name}`,
          isError: true,
        });
      }
      return runEndpoint(env, call, spec);
    },
  }),
});
