import { describe, expect, it, test } from "bun:test";
import type { BaseEnv } from "@intx/agent";
import { HUB_RPC_ENV_KEY } from "@workbench/tool-credentials";
import {
  ATTIO_TASK_AGENT_CLARIFICATION_GATE_DEFINITION,
  ATTIO_TASK_AGENT_MEMBER_SELECTION_GATE_DEFINITION,
  ATTIO_TASK_AGENT_PERSIST_PIECES_DEFINITION,
  ATTIO_TASK_AGENT_REVIEW_GATE_DEFINITION,
  ATTIO_TASK_AGENT_SYNC_APPROVAL_GATE_DEFINITION,
  ATTIO_TASK_AGENT_TASK_SELECTION_GATE_DEFINITION,
  createAttioTaskAgentGateTools,
  createAttioTaskAgentPersistTools,
  MAX_APPROVED_PIECES,
} from "./tools";

function toolFor(definition: { name: string }) {
  const tool = createAttioTaskAgentGateTools().find(
    (t) => t.definition.name === definition.name,
  );
  if (tool === undefined) {
    throw new Error(`no gate tool registered for ${definition.name}`);
  }
  return tool;
}

// `AgentTool["handler"]` can return a bare string for a `kind: "string"` tool;
// every tool in this file is `kind: "full"` and always returns the object
// ToolResult shape — narrow it here so the assertions below don't repeat the
// guard.
function asToolResult(result: unknown): {
  isError?: boolean;
  content: unknown;
} {
  if (typeof result === "string") {
    throw new Error(
      `expected an object ToolResult, got a bare string: ${result}`,
    );
  }
  return result as { isError?: boolean; content: unknown };
}

const signal = new AbortController().signal;

// The `steps` root every gate-prep tool's `input` selector resolves to is
// `Record<stepId, { output }>` — a project selector over it wraps every
// picked field under `.output` (see `projectedStepOutput` in tools.ts).
function stepsArg(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, output]) => [key, { output }]),
  );
}

describe("member-selection gate prep", () => {
  it("renders a choice with the human name leading and the raw assignee as secondary text", async () => {
    const tool = toolFor(ATTIO_TASK_AGENT_MEMBER_SELECTION_GATE_DEFINITION);
    const result = asToolResult(
      await tool.handler(
        {
          id: "c1",
          name: ATTIO_TASK_AGENT_MEMBER_SELECTION_GATE_DEFINITION.name,
          arguments: stepsArg({
            listMembers: {
              content: JSON.stringify([
                {
                  id: { workspace_member_id: "wm_1" },
                  email: "me@abklabs.com",
                  first_name: "Ada",
                },
              ]),
            },
          }),
        },
        signal,
      ),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({
      kind: "choice",
      prompt: "Whose tasks do you want to work?",
      options: [
        {
          id: "me@abklabs.com",
          label: "Ada",
          value: "me@abklabs.com",
          description: "me@abklabs.com",
          payload: { assignee: "me@abklabs.com" },
        },
      ],
    });
  });

  it("degrades to a plain text block (never a dead choice) when the member list is empty", async () => {
    const tool = toolFor(ATTIO_TASK_AGENT_MEMBER_SELECTION_GATE_DEFINITION);
    const result = asToolResult(
      await tool.handler(
        {
          id: "c1",
          name: ATTIO_TASK_AGENT_MEMBER_SELECTION_GATE_DEFINITION.name,
          arguments: stepsArg({ listMembers: { content: JSON.stringify([]) } }),
        },
        signal,
      ),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({
      kind: "text",
      text: "No workspace members are available to assign.",
    });
  });
});

describe("task-selection gate prep", () => {
  it("renders a choice with the due date as secondary text", async () => {
    const tool = toolFor(ATTIO_TASK_AGENT_TASK_SELECTION_GATE_DEFINITION);
    const result = asToolResult(
      await tool.handler(
        {
          id: "c1",
          name: ATTIO_TASK_AGENT_TASK_SELECTION_GATE_DEFINITION.name,
          arguments: stepsArg({
            listTasks: {
              content: JSON.stringify([
                {
                  id: { task_id: "task_1" },
                  content_plaintext: "Reach out",
                  deadline_at: "2026-08-01T00:00:00Z",
                },
              ]),
            },
          }),
        },
        signal,
      ),
    );
    expect(result.content).toEqual({
      kind: "choice",
      prompt: "Pick a task to work.",
      options: [
        {
          id: "task_1",
          label: "Reach out",
          value: "task_1",
          description: "Due 2026-08-01",
          payload: { taskId: "task_1" },
        },
      ],
    });
  });
});

describe("clarification gate prep", () => {
  it("always renders a continue option, folding the planner's questions into the prompt", async () => {
    const tool = toolFor(ATTIO_TASK_AGENT_CLARIFICATION_GATE_DEFINITION);
    const result = asToolResult(
      await tool.handler(
        {
          id: "c1",
          name: ATTIO_TASK_AGENT_CLARIFICATION_GATE_DEFINITION.name,
          arguments: stepsArg({
            analyze: {
              reply: JSON.stringify({
                status: "need_clarification",
                reasoning: "Missing the contact's timezone.",
                questions: ["What timezone is the contact in?"],
              }),
            },
          }),
        },
        signal,
      ),
    );
    expect(result.content).toEqual({
      kind: "choice",
      prompt:
        "Missing the contact's timezone.\n\n• What timezone is the contact in?",
      promptBox: {
        placeholder: "Add the missing detail…",
        payloadKey: "answers",
      },
      options: [{ id: "continue", label: "Continue", value: "", payload: {} }],
    });
  });

  it("degrades to a plain continue when the decision is malformed — never strands the gate", async () => {
    const tool = toolFor(ATTIO_TASK_AGENT_CLARIFICATION_GATE_DEFINITION);
    const result = asToolResult(
      await tool.handler(
        {
          id: "c1",
          name: ATTIO_TASK_AGENT_CLARIFICATION_GATE_DEFINITION.name,
          arguments: stepsArg({ analyze: { reply: "not json" } }),
        },
        signal,
      ),
    );
    const content = result.content as { kind: string; options: unknown[] };
    expect(content.kind).toBe("choice");
    expect(content.options).toEqual([
      { id: "continue", label: "Continue", value: "", payload: {} },
    ]);
  });
});

describe("review gate prep", () => {
  it("builds a reviewList row per draft, keyed with the persist tool's exact field names, defaulting pass/no-review to approved", async () => {
    const tool = toolFor(ATTIO_TASK_AGENT_REVIEW_GATE_DEFINITION);
    const result = asToolResult(
      await tool.handler(
        {
          id: "c1",
          name: ATTIO_TASK_AGENT_REVIEW_GATE_DEFINITION.name,
          arguments: stepsArg({
            execute: {
              reply: JSON.stringify({
                outputs: [
                  { type: "cold-email", title: "Outreach", content: "Hi…" },
                  { type: "twitter-post", title: "Post", content: "Ship it" },
                ],
              }),
            },
            reviewArtifacts: {
              reply: JSON.stringify({
                overall: "Mostly ready.",
                items: [
                  { type: "cold-email", verdict: "pass", notes: "Good." },
                  {
                    type: "twitter-post",
                    verdict: "revise",
                    notes: "Too long.",
                  },
                ],
              }),
            },
          }),
        },
        signal,
      ),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({
      kind: "reviewList",
      title: "Review the drafts",
      prompt: "Mostly ready.",
      displayFields: [
        { key: "title", label: "Draft" },
        { key: "type", label: "Type", kind: "badge" },
        { key: "verdict", label: "Verdict", kind: "badge" },
      ],
      rows: [
        {
          id: "0",
          fields: {
            title: "Outreach",
            type: "cold-email",
            verdict: "approved",
          },
          payload: { type: "cold-email", title: "Outreach", content: "Hi…" },
          defaultDecision: "approved",
        },
        {
          id: "1",
          fields: {
            title: "Post",
            type: "twitter-post",
            verdict: "needs changes",
          },
          payload: { type: "twitter-post", title: "Post", content: "Ship it" },
          defaultDecision: "rejected",
        },
      ],
    });
  });

  it("is FATAL when the executor's reply does not decode — a genuine contract violation, never a placeholder gate", async () => {
    const tool = toolFor(ATTIO_TASK_AGENT_REVIEW_GATE_DEFINITION);
    const result = asToolResult(
      await tool.handler(
        {
          id: "c1",
          name: ATTIO_TASK_AGENT_REVIEW_GATE_DEFINITION.name,
          arguments: stepsArg({
            execute: { reply: "not json" },
            reviewArtifacts: {
              reply: JSON.stringify({ overall: "x", items: [] }),
            },
          }),
        },
        signal,
      ),
    );
    expect(result.isError).toBe(true);
  });
});

describe("sync-approval gate prep", () => {
  it("carries the write-back locators verbatim on the confirm option, plus a skip option", async () => {
    const tool = toolFor(ATTIO_TASK_AGENT_SYNC_APPROVAL_GATE_DEFINITION);
    const result = asToolResult(
      await tool.handler(
        {
          id: "c1",
          name: ATTIO_TASK_AGENT_SYNC_APPROVAL_GATE_DEFINITION.name,
          arguments: stepsArg({
            fetchTask: {
              content: JSON.stringify({
                linkedRecords: [{ object: "companies", recordId: "rec_1" }],
              }),
            },
            selectTask: { taskId: "task_1" },
            analyze: {
              reply: JSON.stringify({
                status: "ready",
                reasoning: "x",
                proposedTaskUpdate: { note: "Drafted outreach." },
              }),
            },
          }),
        },
        signal,
      ),
    );
    expect(result.content).toEqual({
      kind: "choice",
      prompt:
        "Attach a note to the companies record rec_1 and mark the task complete.",
      promptBox: {
        placeholder: "Suggested: Drafted outreach.",
        payloadKey: "content",
      },
      options: [
        {
          id: "attach-and-complete",
          label: "Attach and complete",
          value: "confirm",
          payload: {
            confirm: true,
            taskId: "task_1",
            idempotencyKey: "task_1",
            parentObject: "companies",
            parentRecordId: "rec_1",
          },
        },
        {
          id: "skip",
          label: "Skip the write-back",
          value: "skip",
          payload: { confirm: false },
        },
      ],
    });
  });

  it("degrades to a skip-only choice — never a dead end — when there is no linked record", async () => {
    const tool = toolFor(ATTIO_TASK_AGENT_SYNC_APPROVAL_GATE_DEFINITION);
    const result = asToolResult(
      await tool.handler(
        {
          id: "c1",
          name: ATTIO_TASK_AGENT_SYNC_APPROVAL_GATE_DEFINITION.name,
          arguments: stepsArg({
            fetchTask: { content: JSON.stringify({ linkedRecords: [] }) },
            selectTask: { taskId: "task_1" },
            analyze: {
              reply: JSON.stringify({ status: "ready", reasoning: "x" }),
            },
          }),
        },
        signal,
      ),
    );
    expect(result.content).toEqual({
      kind: "choice",
      prompt: "No linked Attio record to write back to — nothing to sync.",
      options: [
        {
          id: "skip",
          label: "Skip the write-back",
          value: "skip",
          payload: { confirm: false },
        },
      ],
    });
  });
});

describe("persist-pieces", () => {
  it("enforces the documented cap of 4 approved pieces", async () => {
    const tools = createAttioTaskAgentPersistTools({} as BaseEnv);
    const persist = tools[0];
    if (persist === undefined) throw new Error("expected persist tool");
    const pieces = Array.from({ length: 5 }, (_, i) => ({
      title: `t${i}`,
      type: "cold-email",
      content: "c",
    }));
    await expect(
      persist.handler(
        {
          id: "c1",
          name: ATTIO_TASK_AGENT_PERSIST_PIECES_DEFINITION.name,
          arguments: { approvedPieces: pieces },
        },
        signal,
      ),
    ).rejects.toThrow(
      new RegExp(`exceeding the documented cap of ${MAX_APPROVED_PIECES}`),
    );
  });

  // The credentialed inner tool package (`artifact_create`, hub-backed) is
  // constructed LAZILY inside the handler, never at factory-construction time
  // — building the tool bundle with no hub-rpc context in `env` must not
  // throw; only actually invoking the handler (which needs the credential)
  // may fail.
  it("builds with no credential in env without throwing (lazy construction)", () => {
    expect(() => createAttioTaskAgentPersistTools({} as BaseEnv)).not.toThrow();
  });

  it("fails the call (not the whole bundle) when invoked with no hub-rpc context", async () => {
    const tools = createAttioTaskAgentPersistTools({} as BaseEnv);
    const persist = tools[0];
    if (persist === undefined) throw new Error("expected persist tool");
    await expect(
      persist.handler(
        {
          id: "c1",
          name: ATTIO_TASK_AGENT_PERSIST_PIECES_DEFINITION.name,
          arguments: {
            approvedPieces: [{ title: "t", type: "cold-email", content: "c" }],
          },
        },
        signal,
      ),
    ).rejects.toThrow(/hub-RPC context was not injected/);
  });

  // Fatal propagation: a real save failure from the underlying artifact_create
  // hub tool must fail the persist call outright (isError: true) — persist was
  // never a tolerant/best-effort step, matching the original per-item map.
  it("propagates a failed save as isError: true (fatal, unchanged from the pre-migration behavior)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        result: "artifact store is down",
        isError: true,
      })) as unknown as typeof fetch;
    try {
      const tools = createAttioTaskAgentPersistTools({
        [HUB_RPC_ENV_KEY]: {
          baseURL: "https://hub.test",
          token: "t",
          tenantId: "t1",
          agentId: "a1",
          principalId: "p1",
          sessionId: "s1",
        },
      } as unknown as BaseEnv);
      const persist = tools[0];
      if (persist === undefined) throw new Error("expected persist tool");
      const result = asToolResult(
        await persist.handler(
          {
            id: "c1",
            name: ATTIO_TASK_AGENT_PERSIST_PIECES_DEFINITION.name,
            arguments: {
              approvedPieces: [
                { title: "t", type: "cold-email", content: "c" },
              ],
            },
          },
          signal,
        ),
      );
      expect(result.isError).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("createAttioTaskAgentGateTools registers all five gate-prep tools", () => {
  const names = createAttioTaskAgentGateTools().map((t) => t.definition.name);
  expect(names.sort()).toEqual(
    [
      ATTIO_TASK_AGENT_MEMBER_SELECTION_GATE_DEFINITION.name,
      ATTIO_TASK_AGENT_TASK_SELECTION_GATE_DEFINITION.name,
      ATTIO_TASK_AGENT_CLARIFICATION_GATE_DEFINITION.name,
      ATTIO_TASK_AGENT_REVIEW_GATE_DEFINITION.name,
      ATTIO_TASK_AGENT_SYNC_APPROVAL_GATE_DEFINITION.name,
    ].sort(),
  );
});
