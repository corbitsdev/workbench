import { describe, expect, it, mock } from "bun:test";
import {
  HUB_RPC_ENV_KEY,
  toolCredentialEnvKey,
} from "@workbench/tool-credentials";
import {
  PRESENTATION_FETCH_ARTIFACT_DEFINITION,
  PRESENTATION_FETCH_NOTE_DEFINITION,
  createGammaPresentationCreatorFetchTools,
} from "./fetch-tools";
import { toolManifestFile } from "./tool-manifest";

const SIGNAL = new AbortController().signal;

const BASE_ENV = {
  [HUB_RPC_ENV_KEY]: {
    baseURL: "https://hub.test",
    token: "tok",
    tenantId: "tenant_1",
    agentId: "agent_1",
    principalId: "principal_1",
    sessionId: "session_1",
  },
  [toolCredentialEnvKey("granola")]: {
    apiKey: "granola-key",
    baseURL: "https://api.granola.test",
  },
} as unknown as Parameters<typeof createGammaPresentationCreatorFetchTools>[0];

function findTool(name: string) {
  const tool = createGammaPresentationCreatorFetchTools(BASE_ENV).find(
    (t) => t.definition.name === name,
  );
  if (!tool || tool.kind !== "full") {
    throw new Error(`${name} not registered as a full tool`);
  }
  return tool;
}

describe("gamma_presentation_creator_fetch_artifact", () => {
  it("skips without calling the hub when artifactId is absent", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = mock(() => {
      throw new Error("must not call fetch when artifactId is absent");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const tool = findTool("gamma_presentation_creator_fetch_artifact");
      const result = await tool.handler(
        { id: "call_1", name: tool.definition.name, arguments: {} },
        SIGNAL,
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual({ skipped: true });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a completed error envelope (not a throw) when the hub call fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("boom", { status: 500 })),
    ) as unknown as typeof fetch;
    try {
      const tool = findTool("gamma_presentation_creator_fetch_artifact");
      const result = await tool.handler(
        {
          id: "call_2",
          name: tool.definition.name,
          arguments: { artifactId: "art_missing" },
        },
        SIGNAL,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toMatchObject({ isError: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("passes through the real content on a successful hub call", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ result: "hello artifact", isError: false }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;
    try {
      const tool = findTool("gamma_presentation_creator_fetch_artifact");
      const result = await tool.handler(
        {
          id: "call_3",
          name: tool.definition.name,
          arguments: { artifactId: "art_1" },
        },
        SIGNAL,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toEqual("hello artifact");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("gamma_presentation_creator_fetch_note", () => {
  it("skips without calling the network when noteId is absent", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = mock(() => {
      throw new Error("must not call fetch when noteId is absent");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const tool = findTool("gamma_presentation_creator_fetch_note");
      const result = await tool.handler(
        { id: "call_1", name: tool.definition.name, arguments: {} },
        SIGNAL,
      );
      expect(result.content).toEqual({ skipped: true });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a completed error envelope (not a throw) when the Granola call fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("not found", { status: 404 })),
    ) as unknown as typeof fetch;
    try {
      const tool = findTool("gamma_presentation_creator_fetch_note");
      const result = await tool.handler(
        {
          id: "call_2",
          name: tool.definition.name,
          arguments: { noteId: "note_missing" },
        },
        SIGNAL,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toMatchObject({ isError: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a completed error envelope (not a throw) when Granola is unconfigured for the tenant", async () => {
    const envWithoutGranola = {
      [HUB_RPC_ENV_KEY]: BASE_ENV[HUB_RPC_ENV_KEY],
    } as unknown as Parameters<
      typeof createGammaPresentationCreatorFetchTools
    >[0];
    const tool = createGammaPresentationCreatorFetchTools(
      envWithoutGranola,
    ).find(
      (t) => t.definition.name === "gamma_presentation_creator_fetch_note",
    );
    if (!tool || tool.kind !== "full") {
      throw new Error("gamma_presentation_creator_fetch_note not registered");
    }
    const result = await tool.handler(
      {
        id: "call_3",
        name: tool.definition.name,
        arguments: { noteId: "note_1" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatchObject({ isError: true });
  });
});

describe("tool-manifest", () => {
  it("registers both fetch wrapper tools under their own factory", () => {
    const factory = toolManifestFile.factories.find(
      (f) =>
        f.factoryId === "@workbench/tools-gamma-presentation-creator/fetch",
    );
    expect(factory?.bareToolNames).toEqual([
      PRESENTATION_FETCH_ARTIFACT_DEFINITION.name,
      PRESENTATION_FETCH_NOTE_DEFINITION.name,
    ]);
  });
});
