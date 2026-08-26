// A Manus OpenAPI v2 client. Every workbench consumer of Manus goes
// through the same parsed, validated shape. Callers that need graceful
// degradation (the tool bundle) catch at their own boundary rather than
// this client silently swallowing errors.
//
// Auth is never attached here: a mediated credential's `fetch` injects
// `x-manus-api-key` per call (see `@corbits/credential-providers`'s
// `http-x-manus-api-key` plugin). Tests inject a `fetchImpl` and assert
// that this module does not add an auth header of its own.
import { type } from "arktype";

export const DEFAULT_MANUS_BASE_URL = "https://api.manus.ai";

export interface ManusClientConfig {
  /** Override for tests; defaults to the real Manus API host. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

const ManusErrorEnvelope = type({
  ok: "false",
  "request_id?": "string",
  error: {
    code: "string",
    message: "string",
  },
});

const ManusOkEnvelope = type({
  ok: "true",
  "request_id?": "string",
});

const TaskAttachment = type({
  "type?": "string",
  "filename?": "string",
  "url?": "string",
  "id?": "string",
  "content_type?": "string",
});
export type TaskAttachment = typeof TaskAttachment.infer;

const TaskEvent = type({
  "id?": "string",
  "type?": "string",
  "timestamp?": "number",
  "assistant_message?": {
    "content?": "string",
    "attachments?": TaskAttachment.array(),
  },
  "status_update?": {
    "agent_status?": "string",
    "brief?": "string",
    "description?": "string",
  },
  "error_message?": {
    "error_type?": "string",
    "content?": "string",
  },
});
export type TaskEvent = typeof TaskEvent.infer;

export const CreateTaskResponse = type({
  ok: "true",
  "request_id?": "string",
  task_id: "string",
  "task_title?": "string",
  "task_url?": "string",
  "share_url?": "string",
  "share_visibility?": "string",
});
export type CreateTaskResponse = typeof CreateTaskResponse.infer;

export const ListMessagesResponse = type({
  ok: "true",
  "request_id?": "string",
  "task_id?": "string",
  "messages?": TaskEvent.array(),
  "has_more?": "boolean",
  "next_cursor?": "string",
});
export type ListMessagesResponse = typeof ListMessagesResponse.infer;

export type ManusHttpMethod = "GET" | "POST";

export type OutputFile = {
  readonly filename?: string;
  readonly url?: string;
  readonly id?: string;
  readonly type?: string;
  readonly content_type?: string;
};

function jsonHeaders(): Record<string, string> {
  return { "content-type": "application/json" };
}

function throwManusFailure(
  status: number,
  statusText: string,
  body: unknown,
): never {
  const parsed = ManusErrorEnvelope(body);
  if (!(parsed instanceof type.errors)) {
    throw new Error(
      `Manus request failed: ${parsed.error.code}: ${parsed.error.message}`,
    );
  }
  throw new Error(`Manus request failed: ${status} ${statusText}`);
}

function parseOkBody(body: unknown): Record<string, unknown> {
  const error = ManusErrorEnvelope(body);
  if (!(error instanceof type.errors)) {
    throw new Error(
      `Manus request failed: ${error.error.code}: ${error.error.message}`,
    );
  }
  const parsed = ManusOkEnvelope(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Manus response did not match the expected shape: ${parsed.summary}`,
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error(
      "Manus response did not match the expected shape: not an object",
    );
  }
  return body as Record<string, unknown>;
}

function queryString(params: Readonly<Record<string, unknown>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

/**
 * Calls one Manus v2 RPC path. GET arguments become query params; POST
 * arguments become a JSON body. Throws on transport, HTTP, `ok: false`,
 * or envelope-shape failure.
 */
export async function manusRequest(
  config: ManusClientConfig,
  args: {
    readonly method: ManusHttpMethod;
    readonly path: string;
    readonly params?: Readonly<Record<string, unknown>>;
  },
): Promise<Record<string, unknown>> {
  const doFetch = config.fetchImpl ?? fetch;
  const base = config.baseUrl ?? DEFAULT_MANUS_BASE_URL;
  const params = args.params ?? {};
  const url =
    args.method === "GET"
      ? `${base}${args.path}${queryString(params)}`
      : `${base}${args.path}`;
  const response =
    args.method === "GET"
      ? await doFetch(url, { method: "GET" })
      : await doFetch(url, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify(params),
        });
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new Error(
      `Manus request failed: ${response.status} ${response.statusText}`,
      { cause },
    );
  }
  if (!response.ok) {
    throwManusFailure(response.status, response.statusText, body);
  }
  return parseOkBody(body);
}

export type CreateTaskParams = {
  readonly content: string;
  readonly title?: string;
  readonly project_id?: string;
  readonly locale?: string;
  readonly interactive_mode?: boolean;
  readonly hide_in_task_list?: boolean;
  readonly share_visibility?: string;
  readonly agent_profile?: string;
};

export async function createTask(
  config: ManusClientConfig,
  params: CreateTaskParams,
): Promise<CreateTaskResponse> {
  const body: Record<string, unknown> = {
    message: { content: params.content },
  };
  if (params.title !== undefined) body["title"] = params.title;
  if (params.project_id !== undefined) body["project_id"] = params.project_id;
  if (params.locale !== undefined) body["locale"] = params.locale;
  if (params.interactive_mode !== undefined) {
    body["interactive_mode"] = params.interactive_mode;
  }
  if (params.hide_in_task_list !== undefined) {
    body["hide_in_task_list"] = params.hide_in_task_list;
  }
  if (params.share_visibility !== undefined) {
    body["share_visibility"] = params.share_visibility;
  }
  if (params.agent_profile !== undefined) {
    body["agent_profile"] = params.agent_profile;
  }
  const raw = await manusRequest(config, {
    method: "POST",
    path: "/v2/task.create",
    params: body,
  });
  const parsed = CreateTaskResponse(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Manus create-task response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed;
}

export type ListMessagesParams = {
  readonly task_id: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly order?: string;
  readonly verbose?: boolean;
  readonly slides_format?: string;
};

export async function listTaskMessages(
  config: ManusClientConfig,
  params: ListMessagesParams,
): Promise<ListMessagesResponse> {
  const query: Record<string, unknown> = { task_id: params.task_id };
  if (params.limit !== undefined) query["limit"] = params.limit;
  if (params.cursor !== undefined) query["cursor"] = params.cursor;
  if (params.order !== undefined) query["order"] = params.order;
  if (params.verbose !== undefined) query["verbose"] = params.verbose;
  if (params.slides_format !== undefined) {
    query["slides_format"] = params.slides_format;
  }
  const raw = await manusRequest(config, {
    method: "GET",
    path: "/v2/task.listMessages",
    params: query,
  });
  const parsed = ListMessagesResponse(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Manus list-messages response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed;
}

export function latestAgentStatus(
  messages: readonly TaskEvent[] | undefined,
): string | undefined {
  if (messages === undefined) return undefined;
  let status: string | undefined;
  for (const event of messages) {
    const next = event.status_update?.agent_status;
    if (next !== undefined) status = next;
  }
  return status;
}

export function extractOutputFiles(
  messages: readonly TaskEvent[] | undefined,
): readonly OutputFile[] {
  if (messages === undefined) return [];
  const files: OutputFile[] = [];
  for (const event of messages) {
    const attachments = event.assistant_message?.attachments ?? [];
    for (const attachment of attachments) {
      if (
        attachment.filename === undefined &&
        attachment.url === undefined &&
        attachment.id === undefined
      ) {
        continue;
      }
      const file: {
        filename?: string;
        url?: string;
        id?: string;
        type?: string;
        content_type?: string;
      } = {};
      if (attachment.filename !== undefined)
        file.filename = attachment.filename;
      if (attachment.url !== undefined) file.url = attachment.url;
      if (attachment.id !== undefined) file.id = attachment.id;
      if (attachment.type !== undefined) file.type = attachment.type;
      if (attachment.content_type !== undefined) {
        file.content_type = attachment.content_type;
      }
      files.push(file);
    }
  }
  return files;
}

const TERMINAL_STATUSES = new Set(["stopped", "error"]);

export type CreateSlideDeckParams = CreateTaskParams & {
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
};

/**
 * Creates a task whose prompt asks Manus to produce a slide deck, then
 * polls `task.listMessages` until the agent stops (or errors) and returns
 * any output files so a caller can retrieve them.
 */
export async function createSlideDeck(
  config: ManusClientConfig,
  params: CreateSlideDeckParams,
): Promise<{
  readonly task_id: string;
  readonly task_title?: string;
  readonly task_url?: string;
  readonly agent_status?: string;
  readonly files: readonly OutputFile[];
  readonly error?: string;
}> {
  const created = await createTask(config, params);
  const pollIntervalMs = params.pollIntervalMs ?? 1500;
  const maxPolls = params.maxPolls ?? 40;
  let messages: ListMessagesResponse | undefined;
  for (let i = 0; i < maxPolls; i += 1) {
    messages = await listTaskMessages(config, {
      task_id: created.task_id,
      slides_format: "pdf",
    });
    const status = latestAgentStatus(messages.messages);
    if (status !== undefined && TERMINAL_STATUSES.has(status)) break;
    if (i < maxPolls - 1 && pollIntervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  const status = latestAgentStatus(messages?.messages);
  const files = extractOutputFiles(messages?.messages);
  const errorEvent = messages?.messages?.find((event) => event.error_message);
  const result: {
    task_id: string;
    task_title?: string;
    task_url?: string;
    agent_status?: string;
    files: readonly OutputFile[];
    error?: string;
  } = {
    task_id: created.task_id,
    files,
  };
  if (created.task_title !== undefined) result.task_title = created.task_title;
  if (created.task_url !== undefined) result.task_url = created.task_url;
  if (status !== undefined) result.agent_status = status;
  if (errorEvent?.error_message?.content !== undefined) {
    result.error = errorEvent.error_message.content;
  }
  return result;
}
