import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import type { CredentialCapability, MediatedCredential } from "@intx/types";

import {
  CREATE_SLIDES_TOOL,
  MANUS_ENDPOINTS,
  MANUS_NOT_CONNECTED,
  manusTools,
} from "./tool";
import type { ManusEnv } from "./tool";

const CREATE_SLIDES_CALL: ToolCall = {
  id: "call_1",
  name: CREATE_SLIDES_TOOL,
  arguments: { prompt: "Make a five-slide deck about onboarding" },
};

function fakeCredentials(secret: string | undefined): CredentialCapability {
  return {
    resolve(handle: string): Promise<MediatedCredential> {
      if (secret === undefined) {
        return Promise.reject(
          new Error(`no credential is bound to handle "${handle}"`),
        );
      }
      return Promise.resolve({
        kind: "http",
        fetch: (input, init) => fetch(input as string | URL, init),
        dispose: () => {},
      });
    },
  };
}

function fakeEnv(credentials: CredentialCapability | undefined): ManusEnv {
  return { credentials } as unknown as ManusEnv;
}

const STOPPED_WITH_DECK = {
  ok: true,
  task_id: "task_1",
  messages: [
    {
      type: "status_update",
      status_update: { agent_status: "stopped" },
    },
    {
      type: "assistant_message",
      assistant_message: {
        content: "Here is the deck.",
        attachments: [
          {
            type: "slides",
            filename: "onboarding.pptx",
            url: "https://files.manus.ai/onboarding.pptx",
            id: "file_deck_1",
            content_type:
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          },
        ],
      },
    },
  ],
};

test("declares create_slides plus thin tools covering the v2 surface", () => {
  const bundle = manusTools(fakeEnv(fakeCredentials("key")));
  const names = bundle.definitions.map((d) => d.name);
  expect(names).toContain(CREATE_SLIDES_TOOL);
  expect(names).toContain("task_create");
  expect(names).toContain("task_list_msgs");
  expect(names).toContain("file_upload");
  expect(names).toContain("skill_list");
  expect(names).toContain("project_list");
  expect(names).toContain("agent_list");
  expect(names).toContain("webhook_list");
  expect(names).toContain("usage_credits");
  expect(names).toContain("connector_list");
  expect(names).toContain("browser_online");
  expect(names).toContain("website_status");
  expect(names.length).toBe(MANUS_ENDPOINTS.length + 1);
});

test("task_list_msgs describes slides_format as pptx or html, never pdf", () => {
  const listMsgs = MANUS_ENDPOINTS.find(
    (spec) => spec.name === "task_list_msgs",
  );
  expect(listMsgs?.properties["slides_format"]?.description).toContain("pptx");
  expect(listMsgs?.properties["slides_format"]?.description).toContain("html");
  expect(listMsgs?.properties["slides_format"]?.description).not.toMatch(
    /pdf/i,
  );
});

test("degrades to a non-throwing 'not connected' error when no credential is bound", async () => {
  const bundle = manusTools(fakeEnv(fakeCredentials(undefined)));
  const result = await bundle.run(
    CREATE_SLIDES_CALL,
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toBe(MANUS_NOT_CONNECTED);
});

test("degrades the same way when the step carries no credentials capability at all", async () => {
  const bundle = manusTools(fakeEnv(undefined));
  const result = await bundle.run(
    CREATE_SLIDES_CALL,
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toBe(MANUS_NOT_CONNECTED);
});

test("create_slides creates a task, polls messages, and surfaces the presentation file", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/v2/task.create")) {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "");
      expect(body.message.content).toEqual([
        expect.objectContaining({
          type: "text",
        }),
      ]);
      expect(body.message.content[0].text).toContain("slide presentation");
      expect(body.message.content[0].text).toContain("pptx");
      expect(body.message.content[0].text).toContain(
        "Make a five-slide deck about onboarding",
      );
      expect(body.message.enable_skills).toBeUndefined();
      expect(body.message.force_skills).toBeUndefined();
      expect(body.agent_profile).toBe("manus-1.6-lite");
      return new Response(
        JSON.stringify({
          ok: true,
          task_id: "task_1",
          task_title: "Onboarding",
          task_url: "https://manus.im/app/task_1",
        }),
        { status: 200 },
      );
    }
    if (url.includes("/v2/task.listMessages")) {
      expect(url).toContain("slides_format=pptx");
      expect(url).not.toContain("slides_format=pdf");
      return new Response(JSON.stringify(STOPPED_WITH_DECK), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  try {
    const bundle = manusTools(fakeEnv(fakeCredentials("key")));
    const result = await bundle.run(
      CREATE_SLIDES_CALL,
      new AbortController().signal,
    );
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content as string) as {
      task_id: string;
      agent_status: string;
      files: readonly {
        filename: string;
        url: string;
        id: string;
        type: string;
        content_type: string;
      }[];
    };
    expect(parsed.task_id).toBe("task_1");
    expect(parsed.agent_status).toBe("stopped");
    expect(parsed.files).toEqual([
      {
        filename: "onboarding.pptx",
        url: "https://files.manus.ai/onboarding.pptx",
        id: "file_deck_1",
        type: "slides",
        content_type:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      },
    ]);
    expect(urls.some((url) => url.includes("/v2/task.create"))).toBe(true);
    expect(urls.some((url) => url.includes("/v2/task.listMessages"))).toBe(
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("create_slides returns isError when the agent is waiting", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/v2/task.create")) {
      return new Response(JSON.stringify({ ok: true, task_id: "task_1" }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        ok: true,
        task_id: "task_1",
        messages: [
          {
            type: "status_update",
            status_update: { agent_status: "waiting" },
          },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  try {
    const bundle = manusTools(fakeEnv(fakeCredentials("key")));
    const result = await bundle.run(
      CREATE_SLIDES_CALL,
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/waiting for confirmation/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("degrades to an error result (never throws) when the underlying call fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;
  try {
    const bundle = manusTools(fakeEnv(fakeCredentials("key")));
    const result = await bundle.run(
      CREATE_SLIDES_CALL,
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("task_create and task_send_msg expose skill and connector fields", () => {
  const create = MANUS_ENDPOINTS.find((spec) => spec.name === "task_create");
  const send = MANUS_ENDPOINTS.find((spec) => spec.name === "task_send_msg");
  for (const spec of [create, send]) {
    expect(spec?.properties["enable_skills"]?.type).toBe("array");
    expect(spec?.properties["force_skills"]?.type).toBe("array");
    expect(spec?.properties["connectors"]?.type).toBe("array");
    expect(spec?.properties["task_references"]?.type).toBe("array");
  }
  expect(create?.properties["structured_output_schema"]?.type).toBe("object");
  expect(send?.properties["structured_output_schema"]).toBeUndefined();
  expect(create?.properties["agent_profile"]?.description).toContain(
    "manus-1.6-lite",
  );
  expect(create?.properties["agent_profile"]?.description).toMatch(/default/i);
});

test("task_create without agent_profile posts manus-1.6-lite", async () => {
  const originalFetch = globalThis.fetch;
  let createBody = "";
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    createBody = typeof init?.body === "string" ? init.body : "";
    return new Response(JSON.stringify({ ok: true, task_id: "task_1" }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  try {
    const bundle = manusTools(fakeEnv(fakeCredentials("key")));
    const result = await bundle.run(
      {
        id: "call_create_default_profile",
        name: "task_create",
        arguments: { content: "Hello" },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(createBody).agent_profile).toBe("manus-1.6-lite");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("task_create omits skill fields unless the assistant passes ids", async () => {
  const originalFetch = globalThis.fetch;
  let createBody = "";
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    createBody = typeof init?.body === "string" ? init.body : "";
    return new Response(
      JSON.stringify({ ok: true, task_id: "task_1" }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  try {
    const bundle = manusTools(fakeEnv(fakeCredentials("key")));
    const omitted = await bundle.run(
      {
        id: "call_create",
        name: "task_create",
        arguments: { content: "Hello" },
      },
      new AbortController().signal,
    );
    expect(omitted.isError).toBeUndefined();
    expect(JSON.parse(createBody)).toEqual({
      message: { content: [{ type: "text", text: "Hello" }] },
      agent_profile: "manus-1.6-lite",
    });

    const present = await bundle.run(
      {
        id: "call_create_skills",
        name: "task_create",
        arguments: {
          content: "Hello with skills",
          enable_skills: ["skill_abc"],
          force_skills: ["skill_abc"],
          connectors: ["conn_1"],
          task_references: ["task_ref_1"],
          structured_output_schema: { type: "object" },
        },
      },
      new AbortController().signal,
    );
    expect(present.isError).toBeUndefined();
    expect(JSON.parse(createBody)).toEqual({
      message: {
        content: [{ type: "text", text: "Hello with skills" }],
        enable_skills: ["skill_abc"],
        force_skills: ["skill_abc"],
        connectors: ["conn_1"],
        task_references: ["task_ref_1"],
      },
      structured_output_schema: { type: "object" },
      agent_profile: "manus-1.6-lite",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("task_send_msg posts ContentPart content and optional skill fields", async () => {
  const originalFetch = globalThis.fetch;
  let sendBody = "";
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    sendBody = typeof init?.body === "string" ? init.body : "";
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const bundle = manusTools(fakeEnv(fakeCredentials("key")));
    const omitted = await bundle.run(
      {
        id: "call_send",
        name: "task_send_msg",
        arguments: { task_id: "task_1", content: "Follow up" },
      },
      new AbortController().signal,
    );
    expect(omitted.isError).toBeUndefined();
    expect(JSON.parse(sendBody)).toEqual({
      task_id: "task_1",
      message: { content: [{ type: "text", text: "Follow up" }] },
    });

    const present = await bundle.run(
      {
        id: "call_send_skills",
        name: "task_send_msg",
        arguments: {
          task_id: "task_1",
          content: "Follow up with skills",
          enable_skills: ["skill_abc"],
          connectors: ["conn_1"],
          task_references: ["task_ref_1"],
        },
      },
      new AbortController().signal,
    );
    expect(present.isError).toBeUndefined();
    expect(JSON.parse(sendBody)).toEqual({
      task_id: "task_1",
      message: {
        content: [{ type: "text", text: "Follow up with skills" }],
        enable_skills: ["skill_abc"],
        connectors: ["conn_1"],
        task_references: ["task_ref_1"],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
