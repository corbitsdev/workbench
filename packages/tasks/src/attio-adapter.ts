import {
  createAttioTools,
  type AttioFetch,
  type AttioToolsConfig,
} from "@workbench/tools-attio";
import type { AgentTool } from "@intx/agent";

import type {
  TaskAdapter,
  TaskAdapterExecutableOperation,
  TaskPushInput,
  TaskPushResult,
} from "./adapter";

// The Attio adapter is a thin translation layer: it maps the native task push
// vocabulary onto the existing `@workbench/tools-attio` handlers and lets those
// handlers own every HTTP concern (marker idempotency, error surfacing). Tests
// mock only the fetcher, so the adapter → tools-attio seam runs for real.

type AttioCredential = { apiKey: string; baseURL: string };

const ATTIO_LINK_PREFIX = "attio:";

type AttioRecordLink = { object: string; recordId: string };

function findAttioRecordLink(input: TaskPushInput): AttioRecordLink | null {
  for (const link of input.task.links) {
    if (!link.ref.startsWith(ATTIO_LINK_PREFIX)) {
      continue;
    }
    const [, object, recordId] = link.ref.split(":");
    if (object && recordId) {
      return { object, recordId };
    }
  }
  return null;
}

function buildNoteContent(input: TaskPushInput): string {
  const body = input.task.body ?? input.task.title;
  return `${body}\n\n— via Workbench task ${input.task.id} (actor ${input.actorPrincipalId})`;
}

function toolConfig(
  credential: AttioCredential,
  fetcher: AttioFetch,
): AttioToolsConfig {
  const config: AttioToolsConfig = { apiKey: credential.apiKey, fetcher };
  if (credential.baseURL.length > 0) {
    config.baseUrl = credential.baseURL;
  }
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noteId(value: unknown): string | null {
  if (isRecord(value) && isRecord(value.id) && typeof value.id.note_id === "string") {
    return value.id.note_id;
  }
  return null;
}

type AttioAdapterDeps = { fetcher: AttioFetch };

export function createAttioTaskAdapter(deps: AttioAdapterDeps): TaskAdapter {
  function toolHandler(config: AttioToolsConfig, name: string) {
    const tools: AgentTool[] = createAttioTools(config);
    const tool = tools.find((entry) => entry.definition.name === name);
    if (tool === undefined) {
      throw new Error(`Attio adapter could not resolve tool: ${name}`);
    }
    return tool.handler;
  }

  async function writeNote(
    input: TaskPushInput,
    credential: AttioCredential,
  ): Promise<TaskPushResult> {
    const record = findAttioRecordLink(input);
    if (record === null) {
      throw new Error(
        `Attio adapter: task ${input.task.id} carries no attio record link`,
      );
    }
    const handler = toolHandler(
      toolConfig(credential, deps.fetcher),
      "attio_create_note",
    );
    const raw = await handler(
      {
        parentObject: record.object,
        parentRecordId: record.recordId,
        title: input.task.title,
        content: buildNoteContent(input),
        idempotencyKey: input.idempotencyKey,
      },
      new AbortController().signal,
    );
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && parsed.deduped === true) {
      const id = noteId(parsed.note);
      if (id === null) {
        throw new Error("Attio adapter: deduped note is missing a note id");
      }
      return { externalId: id, deduped: true };
    }
    const id = noteId(parsed);
    if (id === null) {
      throw new Error("Attio adapter: created note is missing a note id");
    }
    return { externalId: id, deduped: false };
  }

  async function patchTask(
    input: TaskPushInput,
    credential: AttioCredential,
    data: Record<string, unknown>,
  ): Promise<TaskPushResult> {
    if (input.externalRef === null) {
      throw new Error(
        `Attio adapter: cannot update task ${input.task.id} with no external ref`,
      );
    }
    const handler = toolHandler(
      toolConfig(credential, deps.fetcher),
      "attio_update_task",
    );
    await handler(
      { taskId: input.externalRef.externalId, ...data },
      new AbortController().signal,
    );
    return { externalId: input.externalRef.externalId, deduped: false };
  }

  async function execute(
    op: TaskAdapterExecutableOperation,
    input: TaskPushInput,
    credential: AttioCredential,
  ): Promise<TaskPushResult> {
    if (op === "create" || op === "comment") {
      return writeNote(input, credential);
    }
    if (op === "close") {
      return patchTask(input, credential, { isCompleted: true });
    }
    // update
    const data: Record<string, unknown> = {};
    if (input.task.due !== undefined) {
      data.deadlineAt = input.task.due;
    }
    return patchTask(input, credential, data);
  }

  return {
    id: "attio",
    label: "Attio",
    providerName: "attio",
    operations: ["create", "update", "close", "comment"],
    externalRef: {
      idLabel: "Attio note / task id",
      urlTemplate: "https://app.attio.com/tasks/{externalId}",
    },
    execute,
  };
}
