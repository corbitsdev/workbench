import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentTool } from "@intx/agent";
import type { ToolResult } from "@intx/types/runtime";

// Fake the underlying tool packages at the module boundary so these tests
// exercise the REAL wrapper logic in tools.ts (the tolerant/fatal envelope
// behavior, lazy credential resolution) without a network call.
function fakeTool(
  name: string,
  handler: (args: Record<string, unknown>) => ToolResult,
): AgentTool {
  return {
    kind: "full",
    definition: {
      name,
      description: "",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async (call) => handler(call.arguments),
  };
}

mock.module("@workbench/tools-linear", () => ({
  LINEAR_HUB_TOOLS: {
    linear_list_issues: {
      createTools: () => [
        fakeTool("linear_list_issues", (args) => {
          if (args.first === -1) {
            return { callId: "c", isError: true, content: "linear exploded" };
          }
          return {
            callId: "c",
            content: { issues: [{ id: "i1", title: "Ticket" }] },
          };
        }),
      ],
    },
  },
  createLinearTools: () => [
    fakeTool("linear_get_issue", (args) => {
      if (args.id === "missing") {
        return { callId: "c", isError: true, content: "issue not found" };
      }
      return {
        callId: "c",
        content: {
          identifier: "CL-1",
          title: "Ticket",
          description: "Ship it",
        },
      };
    }),
  ],
}));

mock.module("@workbench/tools-granola", () => ({
  createGranolaTools: () => [
    fakeTool("granola_get_note", (args) => {
      if (args.noteId === "missing") {
        return { callId: "c", isError: true, content: "note not found" };
      }
      return {
        callId: "c",
        content: { title: "Call", transcript: "We talked." },
      };
    }),
  ],
}));

const { createMultiSourceCollateralTools } = await import("./tools");
const { toolManifestFile } = await import("./tool-manifest");

const SIGNAL = new AbortController().signal;

const ENV_WITH_CREDS: Record<string, unknown> = {
  "workbench.cred.linear": {
    apiKey: "linear-key",
    baseURL: "https://linear.example",
  },
  "workbench.cred.granola": {
    apiKey: "granola-key",
    baseURL: "https://granola.example",
  },
  "workbench.hubRpc": {
    baseURL: "https://hub.example",
    token: "hub-token",
    tenantId: "t1",
    agentId: "a1",
    principalId: "p1",
    sessionId: "s1",
  },
};

function fullTool(name: string, env: Record<string, unknown> = ENV_WITH_CREDS) {
  const tool = createMultiSourceCollateralTools(env).find(
    (t) => t.definition.name === name,
  );
  if (!tool || tool.kind !== "full")
    throw new Error(`${name} not registered as a full tool`);
  return tool.handler;
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function mockHubFetch(response: {
  result: string;
  isError: boolean;
  structuredResult?: unknown;
}) {
  global.fetch = mock(
    async () => new Response(JSON.stringify(response), { status: 200 }),
  ) as unknown as typeof fetch;
}

describe("multi_source_collateral_list_issues — tolerant", () => {
  test("returns a completed, non-error envelope on underlying failure", async () => {
    const handler = fullTool("multi_source_collateral_list_issues", {
      ...ENV_WITH_CREDS,
      "workbench.cred.linear": { apiKey: "k", baseURL: "https://x" },
    });
    const result = await handler(
      {
        id: "c",
        name: "multi_source_collateral_list_issues",
        arguments: { first: -1 },
      },
      SIGNAL,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({ isError: true });
  });

  test("returns a completed, non-error envelope with no linear credential at all", async () => {
    const handler = fullTool("multi_source_collateral_list_issues", {});
    const result = await handler(
      {
        id: "c",
        name: "multi_source_collateral_list_issues",
        arguments: { first: 50 },
      },
      SIGNAL,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({ isError: true });
  });

  test("passes through real results on success", async () => {
    const handler = fullTool("multi_source_collateral_list_issues");
    const result = await handler(
      {
        id: "c",
        name: "multi_source_collateral_list_issues",
        arguments: { first: 50 },
      },
      SIGNAL,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ issues: [{ id: "i1", title: "Ticket" }] });
  });
});

describe("multi_source_collateral_prepare_sources_gate", () => {
  test("shapes listed artifacts/notes/issues into a form UIBlock with a multiSelect + free-text field", async () => {
    const handler = fullTool("multi_source_collateral_prepare_sources_gate");
    const result = await handler(
      {
        id: "c",
        name: "multi_source_collateral_prepare_sources_gate",
        arguments: {
          artifacts: [{ id: "a1", title: "Brief" }],
          notes: [{ id: "n1", title: "Call" }],
          issues: [{ id: "i1", identifier: "CL-1", title: "Ticket" }],
        },
      },
      SIGNAL,
    );
    const block = result.content as {
      kind: string;
      fields: { kind: string; name: string; options?: { value: string }[] }[];
    };
    expect(block.kind).toBe("form");
    const sourceIds = block.fields.find((f) => f.name === "sourceIds");
    expect(sourceIds?.options?.map((o) => o.value)).toEqual([
      "artifact:a1",
      "note:n1",
      "issue:i1",
    ]);
    expect(block.fields.some((f) => f.name === "freeText")).toBe(true);
  });
});

describe("multi_source_collateral_fetch_sources — fatal", () => {
  test("combines fetched artifact/note/issue text with free text", async () => {
    mockHubFetch({
      result: "",
      isError: false,
      structuredResult: { title: "Brief", content: "Artifact body" },
    });
    const handler = fullTool("multi_source_collateral_fetch_sources");
    const result = await handler(
      {
        id: "c",
        name: "multi_source_collateral_fetch_sources",
        arguments: {
          sourceIds: ["artifact:a1", "note:n1", "issue:i1"],
          freeText: "Extra",
        },
      },
      SIGNAL,
    );
    expect(result.isError).toBeFalsy();
    const content = result.content as {
      sourceContext: string;
      sourcesSummary: unknown[];
    };
    expect(content.sourceContext).toContain("Artifact body");
    expect(content.sourceContext).toContain("We talked");
    expect(content.sourceContext).toContain("Ship it");
    expect(content.sourceContext).toContain("Extra");
    expect(content.sourcesSummary).toHaveLength(3);
  });

  test("fails the whole step when a SELECTED source fails to fetch (fatal, not tolerant)", async () => {
    const handler = fullTool("multi_source_collateral_fetch_sources");
    const result = await handler(
      {
        id: "c",
        name: "multi_source_collateral_fetch_sources",
        arguments: { sourceIds: ["note:missing"] },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
  });
});

describe("multi_source_collateral_build_generate_items", () => {
  test("builds one item per selected content type", async () => {
    const handler = fullTool("multi_source_collateral_build_generate_items");
    const result = await handler(
      {
        id: "c",
        name: "multi_source_collateral_build_generate_items",
        arguments: {
          sourceContext: "ctx",
          contentTypes: ["linkedin-post", "blog-short"],
        },
      },
      SIGNAL,
    );
    const content = result.content as { items: { contentType: string }[] };
    expect(content.items).toHaveLength(2);
    expect(content.items[0]?.contentType).toBe("linkedin-post");
  });
});

describe("multi_source_collateral_prepare_review_gate", () => {
  test("shapes generated pieces into a reviewList UIBlock", async () => {
    const handler = fullTool("multi_source_collateral_prepare_review_gate");
    const result = await handler(
      {
        id: "c",
        name: "multi_source_collateral_prepare_review_gate",
        arguments: {
          _raw: JSON.stringify([
            { format: "linkedin-post", title: "Hook", content: "Body" },
          ]),
        },
      },
      SIGNAL,
    );
    const block = result.content as {
      kind: string;
      rows: { payload: unknown }[];
    };
    expect(block.kind).toBe("reviewList");
    expect(block.rows).toHaveLength(1);
    expect(block.rows[0]?.payload).toEqual({
      format: "linkedin-post",
      title: "Hook",
      content: "Body",
    });
  });
});

describe("multi_source_collateral_prepare_regenerate_items", () => {
  test("builds a regenerate item per rejected decision, reusing the shared source context", async () => {
    const handler = fullTool(
      "multi_source_collateral_prepare_regenerate_items",
    );
    const result = await handler(
      {
        id: "c",
        name: "multi_source_collateral_prepare_regenerate_items",
        arguments: {
          decisions: [
            {
              approved: false,
              format: "blog-short",
              title: "V1",
              content: "First",
            },
            {
              approved: true,
              format: "linkedin-post",
              title: "Hook",
              content: "Body",
            },
          ],
          sourceContext: "shared ctx",
        },
      },
      SIGNAL,
    );
    const content = result.content as {
      shouldRegenerate: boolean;
      regenerateItems: { previousContent: string; sourceContext: string }[];
    };
    expect(content.shouldRegenerate).toBe(true);
    expect(content.regenerateItems).toHaveLength(1);
    expect(content.regenerateItems[0]?.previousContent).toBe("First");
    expect(content.regenerateItems[0]?.sourceContext).toBe("shared ctx");
  });

  test("shouldRegenerate is false when every decision is approved", async () => {
    const handler = fullTool(
      "multi_source_collateral_prepare_regenerate_items",
    );
    const result = await handler(
      {
        id: "c",
        name: "multi_source_collateral_prepare_regenerate_items",
        arguments: { decisions: [{ approved: true }], sourceContext: "ctx" },
      },
      SIGNAL,
    );
    expect(
      (result.content as { shouldRegenerate: boolean }).shouldRegenerate,
    ).toBe(false);
  });
});

describe("multi_source_collateral_persist_pieces — fatal", () => {
  test("saves every approved piece as an artifact", async () => {
    mockHubFetch({
      result: "",
      isError: false,
      structuredResult: { artifactId: "art_1" },
    });
    const handler = fullTool("multi_source_collateral_persist_pieces");
    const result = await handler(
      {
        id: "c",
        name: "multi_source_collateral_persist_pieces",
        arguments: {
          approvedPieces: [
            { format: "linkedin-post", title: "Hook", content: "Body" },
          ],
        },
      },
      SIGNAL,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ artifacts: [{ artifactId: "art_1" }] });
  });

  test("fails the whole step when a save fails", async () => {
    mockHubFetch({ result: "artifact write failed", isError: true });
    const handler = fullTool("multi_source_collateral_persist_pieces");
    const result = await handler(
      {
        id: "c",
        name: "multi_source_collateral_persist_pieces",
        arguments: {
          approvedPieces: [
            { format: "blog-short", title: "V1", content: "Body" },
          ],
        },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
  });
});

describe("committed tool manifest", () => {
  test("every tool this package registers is declared in the manifest", () => {
    const factory = toolManifestFile.factories[0];
    if (!factory) throw new Error("expected one manifest factory");
    const declared = new Set(factory.bareToolNames);
    for (const tool of createMultiSourceCollateralTools(ENV_WITH_CREDS)) {
      expect(declared.has(tool.definition.name)).toBe(true);
    }
  });
});
