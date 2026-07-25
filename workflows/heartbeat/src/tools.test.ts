import { describe, expect, test } from "bun:test";
import { createHeartbeatTools } from "./tools";
import { toolManifestFile } from "./tool-manifest";
import { HEARTBEAT_INTAKE_SOURCE_DEFINITION } from "./intake-tool";

const SIGNAL = new AbortController().signal;

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
