// The rule this suite exists to hold: nothing a tool call produces reaches
// a reader as an identifier or as JSON. Every assertion below is either
// "this reads like a sentence" or "this string never appears".
import { describe, expect, test } from "bun:test";
import type { Part, ToolTracePart } from "@corbits/chat/parts";

import {
  describeToolCall,
  groupTimelineParts,
  plainTextOfOutput,
  providerTile,
  resolveToolIdentity,
  summarizeToolOutput,
  toToolActivityRow,
} from "./tool-activity";

function trace(part: Partial<ToolTracePart>): ToolTracePart {
  return {
    kind: "tool-trace",
    name: "search",
    input: {},
    status: "success",
    ...part,
  } as ToolTracePart;
}

describe("resolveToolIdentity", () => {
  test("reads the real tool out of the generic MCP dispatch call", () => {
    expect(
      resolveToolIdentity("mcp_read", {
        server: "notion",
        tool: "search_pages",
      }),
    ).toEqual({
      provider: "notion",
      words: ["search", "pages"],
      toolName: "search_pages",
    });
  });

  test("splits a provider-namespaced tool on its double underscore", () => {
    expect(resolveToolIdentity("slack__post_message", {})).toEqual({
      provider: "slack",
      words: ["post", "message"],
      toolName: "post_message",
    });
  });

  test("splits a dotted tool name too", () => {
    expect(resolveToolIdentity("linear.save_issue", {})).toEqual({
      provider: "linear",
      words: ["save", "issue"],
      toolName: "save_issue",
    });
  });

  test("a bare tool name has no provider", () => {
    expect(resolveToolIdentity("webSearch", {})).toEqual({
      provider: undefined,
      words: ["web", "search"],
      toolName: "webSearch",
    });
  });

  test("an MCP dispatch call with a malformed argument bag still resolves", () => {
    expect(resolveToolIdentity("mcp_read", { server: "notion" })).toEqual({
      provider: undefined,
      words: ["mcp", "read"],
      toolName: "mcp_read",
    });
  });
});

describe("describeToolCall", () => {
  test("a web search names what was searched for, in the right tense", () => {
    expect(
      describeToolCall("web_search", { query: "bench pricing" }, "past"),
    ).toBe('Searched the web for "bench pricing"');
    expect(
      describeToolCall("web_search", { query: "bench pricing" }, "present"),
    ).toBe('Searching the web for "bench pricing"');
  });

  test("a provider tool reads as a sentence naming the provider, not the identifier", () => {
    const phrase = describeToolCall(
      "slack__post_message",
      { channel: "general" },
      "past",
    );
    expect(phrase).toBe("Posted a message in Slack #general");
    expect(phrase).not.toContain("__");
    expect(phrase).not.toContain("slack__post_message");
  });

  test("a file tool names the file, not its full path", () => {
    expect(
      describeToolCall(
        "write_file",
        { path: "/srv/app/src/report.md" },
        "past",
      ),
    ).toBe("Wrote a file — report.md");
  });

  test("a url tool names the host", () => {
    expect(
      describeToolCall(
        "fetch_page",
        { url: "https://www.example.com/a/b" },
        "past",
      ),
    ).toBe("Fetched a page on example.com");
  });

  test("an MCP dispatch call describes the tool it actually invoked", () => {
    expect(
      describeToolCall(
        "mcp_call",
        { server: "linear", tool: "save_issue", query: "auth bug" },
        "past",
      ),
    ).toBe('Saved an issue in Linear for "auth bug"');
  });

  test("an unknown verb still loses its underscores rather than leaking raw", () => {
    const phrase = describeToolCall("acme__frobnicate_widget", {}, "past");
    expect(phrase).toBe("Frobnicate widget");
    expect(phrase).not.toContain("_");
  });

  test("a plural object drops the article", () => {
    expect(describeToolCall("list_files", {}, "past")).toBe("Listed files");
  });

  test("a colon-namespaced GitHub tool still names the provider, not the id", () => {
    expect(describeToolCall("github:get_issue", {}, "past")).toBe(
      "Retrieved an issue in GitHub",
    );
    expect(describeToolCall("github__get_issue", {}, "past")).toBe(
      "Retrieved an issue in GitHub",
    );
  });

  test("a bare search names the query and never the identifier", () => {
    expect(describeToolCall("search", { q: "x" }, "past")).toBe(
      'Searched for "x"',
    );
  });

  test("an unknown colon-namespaced verb title-cases the end name, not the package", () => {
    expect(describeToolCall("acme:frobnicate_widget", {}, "past")).toBe(
      "Frobnicate widget",
    );
  });

  test("an Interchange memory search is a layman sentence, not a qualified id", () => {
    const phrase = describeToolCall(
      "@corbits/memory-tools/memory:memory_search",
      { query: "outbound" },
      "past",
    );
    expect(phrase).toBe('Searched memory for "outbound"');
    expect(phrase).not.toContain("@");
    expect(phrase).not.toContain("/");
    expect(phrase).not.toContain(":");
  });

  test("an Interchange memory search still running has no query to name", () => {
    expect(
      describeToolCall(
        "@corbits/memory-tools/memory:memory_search",
        {},
        "present",
      ),
    ).toBe("Searching memory");
  });

  test("an Interchange list-agents call pluralizes without a package path", () => {
    expect(
      describeToolCall(
        "@corbits/agent-directory-tools/ad:list_agents",
        {},
        "past",
      ),
    ).toBe("Listed agents");
  });

  test("an Interchange ask-user call is a question, not the tool id", () => {
    expect(
      describeToolCall(
        "@corbits/interaction-tools/ask-user:ask_user",
        {},
        "past",
      ),
    ).toBe("Asked a question");
  });
});

describe("plainTextOfOutput", () => {
  test("pulls the text out of MCP content blocks", () => {
    expect(
      plainTextOfOutput([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  test("unwraps a result envelope's content", () => {
    expect(plainTextOfOutput({ content: [{ type: "text", text: "hi" }] })).toBe(
      "hi",
    );
  });

  test("returns nothing for an opaque object rather than stringifying it", () => {
    expect(plainTextOfOutput({ rows: 4, cursor: "abc" })).toBeUndefined();
  });
});

describe("summarizeToolOutput", () => {
  test("a failure always says something, even with nothing to go on", () => {
    expect(summarizeToolOutput("failed", undefined)).toBe("No reason given.");
  });

  test("a failure keeps its first line as the reason", () => {
    expect(
      summarizeToolOutput("failed", "Repository not found\n  at listIssues"),
    ).toBe("Repository not found");
  });

  test("a success with no prose falls back to counting the results", () => {
    expect(summarizeToolOutput("success", [{ id: 1 }, { id: 2 }])).toBe(
      "2 results.",
    );
    expect(summarizeToolOutput("success", [])).toBe("Nothing found.");
  });

  test("a running call has no detail to open onto yet", () => {
    expect(summarizeToolOutput("running", undefined)).toBeUndefined();
  });

  test("an opaque success detail never becomes JSON", () => {
    const detail = summarizeToolOutput("success", { cursor: "abc" });
    expect(detail).toBeUndefined();
  });
});

describe("toToolActivityRow", () => {
  test("a failed call is failed, and says why in plain text", () => {
    const row = toToolActivityRow(
      trace({
        name: "github__get_issue",
        input: { repo: "corbitsdev/workbench" },
        status: "error",
        output: [{ type: "text", text: "Repository not found" }],
      }),
      "k",
    );
    expect(row.status).toBe("failed");
    expect(row.phrase).toBe(
      "Retrieved an issue in GitHub corbitsdev/workbench",
    );
    expect(row.detail).toBe("Repository not found");
  });

  test("a running call speaks in the present tense", () => {
    const row = toToolActivityRow(
      trace({ name: "web_search", input: { query: "x" }, status: "running" }),
      "k",
    );
    expect(row.phrase).toBe('Searching the web for "x"');
    expect(row.detail).toBeUndefined();
  });

  test("an Interchange memory search carries the end name, no provider, and a search glyph", () => {
    const row = toToolActivityRow(
      trace({
        name: "@corbits/memory-tools/memory:memory_search",
        input: { query: "outbound" },
        status: "success",
      }),
      "k",
    );
    expect(row.phrase).toBe('Searched memory for "outbound"');
    expect(row.provider).toBeUndefined();
    expect(row.toolName).toBe("memory_search");
    expect(["search", "memory"]).toContain(row.glyph);
    expect(row.phrase).not.toContain("@");
    expect(row.phrase).not.toContain("/");
    expect(row.phrase).not.toContain(":");
  });

  test("ask_user success never opens onto the model-facing instruction", () => {
    const row = toToolActivityRow(
      trace({
        name: "@corbits/interaction-tools/ask-user:ask_user",
        status: "success",
        output:
          "The question has been shown to the user. Do not repeat the question.",
      }),
      "k",
    );
    expect(row.phrase).toBe("Asked a question");
    expect(row.detail).toBeUndefined();
    expect(row.toolName).toBe("ask_user");
    expect(row.glyph).toBe("ask");
  });

  test("a JSON items payload becomes a result count, not the JSON", () => {
    const json = JSON.stringify({ items: [{}, {}, {}] });
    const row = toToolActivityRow(
      trace({
        name: "memory_search",
        status: "success",
        output: json,
      }),
      "k",
    );
    expect(row.detail).toBe("3 results.");
    expect(row.detail).not.toContain("{");
    expect(row.detail).not.toContain("items");
  });

  test("JSON sitting inside a content-block text field is still a count, not the JSON", () => {
    const row = toToolActivityRow(
      trace({
        name: "memory_search",
        status: "success",
        output: [
          {
            type: "text",
            text: JSON.stringify({ items: [{}, {}] }),
          },
        ],
      }),
      "k",
    );
    expect(row.detail).toBe("2 results.");
    expect(row.detail).not.toContain("{");
  });

  test("an unknown colon leftover is not a provider", () => {
    const row = toToolActivityRow(
      trace({ name: "acme:frobnicate_widget", status: "success" }),
      "k",
    );
    expect(row.provider).toBeUndefined();
    expect(row.phrase).toBe("Frobnicate widget");
  });
});

describe("providerTile", () => {
  test("a known provider gets its brand initials and color", () => {
    expect(providerTile("linear")).toEqual({
      initials: "Li",
      color: "#5e6ad2",
    });
    expect(providerTile("github")).toEqual({
      initials: "GH",
      color: "#24292f",
    });
  });

  test("an unrecognized leftover is not a brand tile", () => {
    expect(providerTile("acme")).toBeUndefined();
    expect(providerTile("memory")).toBeUndefined();
  });
});

describe("groupTimelineParts", () => {
  const text = (value: string): Part => ({ kind: "text", text: value });

  test("consecutive tool calls fold into one round", () => {
    const groups = groupTimelineParts(
      [
        text("Looking into it."),
        trace({ name: "web_search" }),
        trace({ name: "read_file" }),
        trace({ name: "write_file" }),
        text("Here is what I found."),
      ],
      "m1",
    );
    expect(groups.map((group) => group.kind)).toEqual([
      "part",
      "tool-activity",
      "part",
    ]);
    const round = groups[1];
    expect(round?.kind === "tool-activity" && round.rows.length).toBe(3);
  });

  test("rounds separated by prose stay separate rounds", () => {
    const groups = groupTimelineParts(
      [trace({}), text("mid"), trace({}), trace({})],
      "m1",
    );
    expect(groups.map((group) => group.kind)).toEqual([
      "tool-activity",
      "part",
      "tool-activity",
    ]);
  });

  test("a message with no tool calls is unchanged", () => {
    const groups = groupTimelineParts([text("hello")], "m1");
    expect(groups).toEqual([
      { kind: "part", part: text("hello"), key: "m1-0" },
    ]);
  });
});
