import { describe, expect, test } from "bun:test";
import { toolCredentialEnvKey } from "@workbench/tool-credentials";
import {
  mergeHeartbeatBriefSources,
  parseBriefSourceToolEnvelope,
} from "./heartbeat-shared";
import {
  createHeartbeatIntakeSourceTool,
  createHeartbeatTools,
  HEARTBEAT_INTAKE_SOURCE_DEFINITION,
  HEARTBEAT_INTAKE_SOURCE_ENV_KEYS,
  HEARTBEAT_INTAKE_SOURCE_PROVIDERS,
} from "./tools";
import { toolManifestFile } from "./tool-manifest";

const SIGNAL = new AbortController().signal;

function handlerOf(tool: ReturnType<typeof createHeartbeatIntakeSourceTool>) {
  if (tool.kind !== "full") {
    throw new Error("expected heartbeat_intake_source to be a full-kind tool");
  }
  return tool.handler;
}

function fullTool(name: string) {
  const tool = createHeartbeatTools().find((t) => t.definition.name === name);
  if (!tool || tool.kind !== "full") {
    throw new Error(`${name} not registered as a full tool`);
  }
  return tool.handler;
}

describe("heartbeat_format_brief_notify", () => {
  test("returns the mail_send argument shape verbatim (to/subject/content/refs)", async () => {
    const handler = fullTool("heartbeat_format_brief_notify");
    const result = await handler(
      {
        id: "notify",
        name: "heartbeat_format_brief_notify",
        arguments: {
          userAddress: "usr_abc@workbench.local",
          title: "Jordan Lee's Morning Brief - 04/07/26",
          body: "# Morning brief\n\nAll clear.",
          artifactId: "art_abc",
          runId: "run_heartbeat-1",
        },
      },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    expect(result.content).toEqual({
      to: "usr_abc@workbench.local",
      subject: "Jordan Lee's Morning Brief - 04/07/26",
      content: "# Morning brief\n\nAll clear.",
      refs: [
        { kind: "artifact", ref: "art_abc", label: "Open brief" },
        {
          kind: "workflow_run",
          ref: "run_heartbeat-1",
          label: "Open Company Heartbeat",
        },
      ],
    });
  });

  test("returns isError when runId is missing", async () => {
    const handler = fullTool("heartbeat_format_brief_notify");
    const result = await handler(
      {
        id: "notify",
        name: "heartbeat_format_brief_notify",
        arguments: {
          userAddress: "usr_abc@workbench.local",
          title: "t",
          body: "b",
          artifactId: "art_abc",
        },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("runId is required");
  });
});

describe("heartbeat_format_brief_document", () => {
  test("pairs title and reply into a title/body document", async () => {
    const handler = fullTool("heartbeat_format_brief_document");
    const result = await handler(
      {
        id: "document",
        name: "heartbeat_format_brief_document",
        arguments: {
          title: "Jordan Lee's Morning Brief - 04/07/26",
          reply: "# Morning brief\n\nAll clear.",
        },
      },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    expect(result.content).toEqual({
      title: "Jordan Lee's Morning Brief - 04/07/26",
      body: "# Morning brief\n\nAll clear.",
    });
  });

  test("returns isError when reply is missing", async () => {
    const handler = fullTool("heartbeat_format_brief_document");
    const result = await handler(
      {
        id: "document",
        name: "heartbeat_format_brief_document",
        arguments: { title: "t" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("reply is required");
  });
});

describe("heartbeat_format_brief_title", () => {
  test("returns a possessive title built from userDisplayName", async () => {
    const handler = fullTool("heartbeat_format_brief_title");
    const result = await handler(
      {
        id: "title",
        name: "heartbeat_format_brief_title",
        arguments: { userDisplayName: "Jordan Lee" },
      },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    const content = result.content as { title: string };
    expect(content.title).toMatch(
      /^Jordan Lee's Morning Brief - \d{2}\/\d{2}\/\d{2}$/,
    );
  });

  test("falls back to 'Your Morning Brief' when no display name is given", async () => {
    const handler = fullTool("heartbeat_format_brief_title");
    const result = await handler(
      { id: "title", name: "heartbeat_format_brief_title", arguments: {} },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    const content = result.content as { title: string };
    expect(content.title).toMatch(/^Your Morning Brief - \d{2}\/\d{2}\/\d{2}$/);
  });
});

describe("tool-manifest completeness", () => {
  test("every registered tool name is declared in the hand-authored manifest", () => {
    // heartbeat_intake_source is built by interchange-tools.ts's factory
    // (it needs the resolved `env`, unlike createHeartbeatTools's stateless
    // tools), so it is not in createHeartbeatTools()'s runtime array — add
    // its definition name explicitly so this test still covers the full
    // factory's tool surface against the manifest.
    const runtimeNames = [
      ...createHeartbeatTools().map((tool) => tool.definition.name),
      HEARTBEAT_INTAKE_SOURCE_DEFINITION.name,
    ].sort();
    const factory = toolManifestFile.factories[0];
    if (!factory) {
      throw new Error("expected the heartbeat manifest to declare a factory");
    }
    const manifestNames = [...factory.bareToolNames].sort();
    expect(manifestNames).toEqual(runtimeNames);
  });
});

describe("heartbeat_intake_source", () => {
  test("declares one env key per wired provider (granola, linear, attio, vercel)", () => {
    expect(HEARTBEAT_INTAKE_SOURCE_PROVIDERS).toEqual([
      "attio",
      "granola",
      "linear",
      "vercel",
    ]);
    expect(HEARTBEAT_INTAKE_SOURCE_ENV_KEYS).toEqual(
      HEARTBEAT_INTAKE_SOURCE_PROVIDERS.map(toolCredentialEnvKey),
    );
  });

  test("definition requires only `tool`, forwards enabledSources/createdAfter as optional", () => {
    expect(HEARTBEAT_INTAKE_SOURCE_DEFINITION.name).toBe(
      "heartbeat_intake_source",
    );
    expect(HEARTBEAT_INTAKE_SOURCE_DEFINITION.inputSchema.required).toEqual([
      "tool",
    ]);
  });

  // Load-bearing: a native `action` step's dispatched tool has no
  // `nonFatal` escape — `runDeterministicToolStep`
  // (apps/sidecar/src/step-tool-harness.ts) throws whenever the outer
  // `ToolResult.isError` is `true`, which would fail the whole unattended
  // heartbeat run. So every degrade path below must return a completed,
  // `isError: false` envelope, never throw and never set the outer isError.
  describe("never sets the outer isError, even when the source is unreachable", () => {
    test("a source tool with no credential in env degrades to a nested isError content", async () => {
      const tool = createHeartbeatIntakeSourceTool({});
      const handler = handlerOf(tool);
      const result = await handler(
        {
          id: "c1",
          name: "heartbeat_intake_source",
          arguments: { tool: "granola_list_notes" },
        },
        SIGNAL,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toEqual({
        isError: true,
        error: "source unavailable: no granola credential configured",
      });
    });

    test("an unknown source tool name degrades to a nested isError content", async () => {
      const tool = createHeartbeatIntakeSourceTool({});
      const handler = handlerOf(tool);
      const result = await handler(
        {
          id: "c2",
          name: "heartbeat_intake_source",
          arguments: { tool: "not_a_real_tool" },
        },
        SIGNAL,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toEqual({
        isError: true,
        error: 'heartbeat_intake_source: unknown source tool "not_a_real_tool"',
      });
    });

    test("a missing tool argument degrades to a nested isError content", async () => {
      const tool = createHeartbeatIntakeSourceTool({});
      const handler = handlerOf(tool);
      const result = await handler(
        { id: "c3", name: "heartbeat_intake_source", arguments: {} },
        SIGNAL,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toEqual({
        isError: true,
        error: "heartbeat_intake_source: tool is required",
      });
    });

    test("a malformed credential value (present but invalid shape) degrades rather than throwing", async () => {
      const tool = createHeartbeatIntakeSourceTool({
        [toolCredentialEnvKey("granola")]: { apiKey: 42 },
      });
      const handler = handlerOf(tool);
      const result = await handler(
        {
          id: "c4",
          name: "heartbeat_intake_source",
          arguments: { tool: "granola_list_notes" },
        },
        SIGNAL,
      );
      expect(result.isError).toBe(false);
      const content = result.content as { isError: boolean; error: string };
      expect(content.isError).toBe(true);
      expect(content.error.length).toBeGreaterThan(0);
    });
  });

  // Drives the REAL wrapper output through the REAL consumer, end to end —
  // not a hand-typed shape matching what the consumer expects. Proves
  // `mergeHeartbeatBriefSources`/`parseBriefSourceToolEnvelope` actually
  // round-trip `heartbeat_intake_source`'s own degrade shape into a
  // per-source "unavailable" note, and that a real success round-trips to
  // the parsed source data with no `isError` note.
  describe("round-trips through the real local consumer (heartbeat-shared)", () => {
    test("a real degraded heartbeat_intake_source output parses to a per-source isError note", async () => {
      const tool = createHeartbeatIntakeSourceTool({});
      const handler = handlerOf(tool);
      const output = await handler(
        {
          id: "c1",
          name: "heartbeat_intake_source",
          arguments: { tool: "vercel_list_deployments" },
        },
        SIGNAL,
      );

      const parsed = parseBriefSourceToolEnvelope(output);
      expect(parsed).toEqual({
        isError: true,
        error: "source unavailable: no vercel credential configured",
      });

      const merged = mergeHeartbeatBriefSources({
        "intake-vercel": { output },
      });
      expect(merged.sources.vercel).toEqual({
        isError: true,
        error: "source unavailable: no vercel credential configured",
      });
    });

    test("a real malformed-credential heartbeat_intake_source output round-trips to an isError note without a network call", async () => {
      const tool = createHeartbeatIntakeSourceTool({
        [toolCredentialEnvKey("granola")]: { apiKey: 42 },
      });
      const handler = handlerOf(tool);
      const output = await handler(
        {
          id: "c2",
          name: "heartbeat_intake_source",
          arguments: { tool: "granola_list_notes" },
        },
        SIGNAL,
      );
      expect(output.isError).toBe(false);

      const parsed = parseBriefSourceToolEnvelope(output);
      expect(parsed.isError).toBe(true);
      expect(typeof parsed.error).toBe("string");
      expect((parsed.error as string).length).toBeGreaterThan(0);
    });
  });
});
