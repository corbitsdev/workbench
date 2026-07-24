import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import {
  createGranolaTools,
  GRANOLA_DEFAULT_BASE_URL,
  GRANOLA_HUB_TOOLS,
} from "./index";

describe("createGranolaTools", () => {
  it("falls back to the package default base URL when none is provided", async () => {
    const fetcher = mock(async (input: string) => {
      expect(String(input)).toBe(
        `${GRANOLA_DEFAULT_BASE_URL}/notes?page_size=10`,
      );
      return new Response(JSON.stringify({ notes: [], hasMore: false }), {
        status: 200,
      });
    });

    const runner = createToolRunner(
      createGranolaTools({ apiKey: "tenant-api-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "granola_list_notes", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("skips the network call and reports skipped when granola is not in enabledSources", async () => {
    const fetcher = mock(async () => {
      throw new Error("should not be called");
    });

    const runner = createToolRunner(
      createGranolaTools({ apiKey: "tenant-api-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "granola_list_notes",
        arguments: { enabledSources: ["email"] },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(String(result.content))).toEqual({
      notes: [],
      hasMore: false,
      skipped: true,
    });
  });

  it("accepts a hub-enriched heartbeat trigger payload (extra mail fields)", async () => {
    const fetcher = mock(async (input: string) => {
      const url = new URL(String(input));
      if (url.searchParams.has("created_after")) {
        return new Response(
          JSON.stringify({
            notes: [
              { id: "n1", title: "Call", created_at: "2026-07-10T00:00:00Z" },
            ],
            hasMore: false,
          }),
          {
            status: 200,
          },
        );
      }
      return new Response(JSON.stringify({ notes: [], hasMore: false }), {
        status: 200,
      });
    });

    const runner = createToolRunner(
      createGranolaTools({ apiKey: "tenant-api-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "granola_list_notes",
        arguments: {
          reason: "manual-brief",
          userAddress: "usr_abc@workbench.local",
          userRefId: "usr_abc",
          enabledSources: ["granola", "linear", "attio"],
          createdAfter: "2026-07-04T00:00:00Z",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(result.content)).notes).toHaveLength(1);
  });

  it("calls granola normally when enabledSources includes granola", async () => {
    const fetcher = mock(async () => {
      return new Response(JSON.stringify({ notes: [], hasMore: false }), {
        status: 200,
      });
    });

    const runner = createToolRunner(
      createGranolaTools({ apiKey: "tenant-api-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "granola_list_notes",
        arguments: { enabledSources: ["granola"] },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("queries both created_after and updated_after and merges by note id (CL-4085)", async () => {
    const fetcher = mock(async (input: string) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("page_size")).toBe("30");
      if (url.searchParams.get("created_after") === "2026-07-04T00:00:00Z") {
        return new Response(
          JSON.stringify({
            notes: [
              {
                id: "n1",
                title: "New call",
                created_at: "2026-07-10T00:00:00Z",
              },
            ],
            hasMore: false,
          }),
          { status: 200 },
        );
      }
      expect(url.searchParams.get("updated_after")).toBe(
        "2026-07-04T00:00:00Z",
      );
      return new Response(
        JSON.stringify({
          notes: [
            {
              id: "n2",
              title: "Revised call",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-11T00:00:00Z",
            },
          ],
          hasMore: false,
        }),
        { status: 200 },
      );
    });

    const runner = createToolRunner(
      createGranolaTools({ apiKey: "tenant-api-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_brief_merge",
        name: "granola_list_notes",
        arguments: {
          enabledSources: ["granola"],
          createdAfter: "2026-07-04T00:00:00Z",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String(result.content));
    expect(body.notes.map((note: { id: string }) => note.id)).toEqual([
      "n1",
      "n2",
    ]);
    const revised = body.notes.find((note: { id: string }) => note.id === "n2");
    expect(revised.updatedOnly).toBe(true);
    const fresh = body.notes.find((note: { id: string }) => note.id === "n1");
    expect(fresh.updatedOnly).toBeUndefined();
  });

  it("does not tag a note updatedOnly when it also matches created_after (CL-4085)", async () => {
    const fetcher = mock(async (input: string) => {
      const url = new URL(String(input));
      const note = {
        id: "n1",
        title: "New call",
        created_at: "2026-07-10T00:00:00Z",
        updated_at: "2026-07-10T00:00:00Z",
      };
      if (url.searchParams.has("created_after")) {
        return new Response(JSON.stringify({ notes: [note], hasMore: false }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ notes: [note], hasMore: false }), {
        status: 200,
      });
    });

    const runner = createToolRunner(
      createGranolaTools({ apiKey: "tenant-api-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_brief_dedupe",
        name: "granola_list_notes",
        arguments: {
          enabledSources: ["granola"],
          createdAfter: "2026-07-04T00:00:00Z",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(String(result.content));
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0].updatedOnly).toBeUndefined();
  });

  it("sorts the brief-shaped merged result by created_at desc (CL-4085)", async () => {
    const fetcher = mock(async (input: string) => {
      const url = new URL(String(input));
      if (url.searchParams.has("created_after")) {
        return new Response(
          JSON.stringify({
            notes: [
              { id: "old", title: "Old", created_at: "2026-07-05T00:00:00Z" },
              { id: "new", title: "New", created_at: "2026-07-12T00:00:00Z" },
            ],
            hasMore: false,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ notes: [], hasMore: false }), {
        status: 200,
      });
    });

    const runner = createToolRunner(
      createGranolaTools({ apiKey: "tenant-api-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_brief_sort",
        name: "granola_list_notes",
        arguments: {
          enabledSources: ["granola"],
          createdAfter: "2026-07-04T00:00:00Z",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(String(result.content));
    expect(body.notes.map((note: { id: string }) => note.id)).toEqual([
      "new",
      "old",
    ]);
  });

  it("follows the cursor per query up to a 5-page cap (CL-4085)", async () => {
    let createdAfterCalls = 0;
    const fetcher = mock(async (input: string) => {
      const url = new URL(String(input));
      if (!url.searchParams.has("created_after")) {
        return new Response(JSON.stringify({ notes: [], hasMore: false }), {
          status: 200,
        });
      }
      createdAfterCalls += 1;
      return new Response(
        JSON.stringify({
          notes: [
            {
              id: `n${createdAfterCalls}`,
              title: "Call",
              created_at: "2026-07-10T00:00:00Z",
            },
          ],
          hasMore: true,
          cursor: `cursor-${createdAfterCalls}`,
        }),
        { status: 200 },
      );
    });

    const runner = createToolRunner(
      createGranolaTools({ apiKey: "tenant-api-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_brief_pagination",
        name: "granola_list_notes",
        arguments: {
          enabledSources: ["granola"],
          createdAfter: "2026-07-04T00:00:00Z",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(createdAfterCalls).toBe(5);
    const body = JSON.parse(String(result.content));
    expect(body.notes).toHaveLength(5);
  });

  it("degrades to skipped when the brief-shaped dual query hits a 401 (CL-4085)", async () => {
    const fetcher = mock(
      async () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
        }),
    );

    const runner = createToolRunner(
      createGranolaTools({ apiKey: "invalid-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_brief_auth",
        name: "granola_list_notes",
        arguments: {
          enabledSources: ["granola"],
          createdAfter: "2026-07-04T00:00:00Z",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      notes: [],
      hasMore: false,
      skipped: true,
    });
  });

  it("returns the Granola agent tools", () => {
    const tools = createGranolaTools({
      apiKey: "tenant-api-key",
      baseUrl: "https://public-api.granola.ai/v1",
    });

    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "granola_list_notes",
      "granola_get_note",
      "granola_list_folders",
    ]);
  });

  // Routine/intake fields deliver numbers as TEXT: a scheduled granola-call
  // run's trigger payload carries maxCalls "10" (string), which the discover
  // argMap forwards verbatim as `limit`. The tool must coerce a numeric
  // string instead of failing the whole run with "limit must be a number
  // (was a string)" — the production failure this pins.
  it("accepts a numeric-string limit (routine text intake) and still rejects garbage", async () => {
    const fetcher = mock(async (input: string) => {
      expect(new URL(String(input)).searchParams.get("page_size")).toBe("3");
      return new Response(
        JSON.stringify({ notes: [], hasMore: false }),
        { status: 200 },
      );
    });
    const runner = createToolRunner(
      createGranolaTools({
        apiKey: "tenant-api-key",
        baseUrl: "https://public-api.granola.ai/v1",
        fetcher,
      }),
    );

    const ok = await runner.run(
      {
        id: "call_s",
        name: "granola_list_notes",
        arguments: { limit: "3" },
      },
      new AbortController().signal,
    );
    expect(ok.isError).toBeUndefined();

    const bad = await runner.run(
      {
        id: "call_b",
        name: "granola_list_notes",
        arguments: { limit: "lots" },
      },
      new AbortController().signal,
    );
    expect(bad.isError).toBe(true);
    expect(String(bad.content)).toContain("limit");
  });

  it("lists notes using the page_size query parameter", async () => {
    const fetcher = mock(async (input: string, init: RequestInit) => {
      expect(String(input)).toBe(
        "https://public-api.granola.ai/v1/notes?page_size=2",
      );
      expect(init?.headers).toEqual({
        Authorization: "Bearer tenant-api-key",
        "Content-Type": "application/json",
      });

      return new Response(
        JSON.stringify({
          notes: [
            {
              id: "note_1",
              title: "Sales Call",
              created_at: "2026-05-28T10:00:00Z",
              participants: ["Ada"],
            },
          ],
          hasMore: false,
        }),
        { status: 200 },
      );
    });

    const runner = createToolRunner(
      createGranolaTools({
        apiKey: "tenant-api-key",
        baseUrl: "https://public-api.granola.ai/v1",
        fetcher,
      }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "granola_list_notes",
        arguments: { limit: 2 },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      JSON.stringify(
        {
          notes: [
            {
              id: "note_1",
              title: "Sales Call",
              created_at: "2026-05-28T10:00:00Z",
              participants: ["Ada"],
            },
          ],
          hasMore: false,
        },
        null,
        2,
      ),
    );
  });

  it("caps requested list size at the API maximum of 30", async () => {
    const fetcher = mock(async (input: string, _init: RequestInit) => {
      expect(input).toBe("https://public-api.granola.ai/v1/notes?page_size=30");

      return new Response(JSON.stringify({ notes: [], hasMore: false }), {
        status: 200,
      });
    });

    const runner = createToolRunner(
      createGranolaTools({
        apiKey: "tenant-api-key",
        baseUrl: "https://public-api.granola.ai/v1",
        fetcher,
      }),
    );

    const result = await runner.run(
      {
        id: "call_capped",
        name: "granola_list_notes",
        arguments: { limit: 10_000 },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('"notes": []');
  });

  it("forwards date and folder filters when listing notes", async () => {
    const fetcher = mock(async (input: string) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1/notes");
      expect(url.searchParams.get("page_size")).toBe("10");
      expect(url.searchParams.get("created_after")).toBe("2026-01-01");
      expect(url.searchParams.get("created_before")).toBe(
        "2026-02-01T00:00:00Z",
      );
      expect(url.searchParams.get("updated_after")).toBe("2026-01-15");
      expect(url.searchParams.get("folder_id")).toBe("fol_4y6LduVdwSKC27");

      return new Response(JSON.stringify({ notes: [], hasMore: false }), {
        status: 200,
      });
    });

    const runner = createToolRunner(
      createGranolaTools({
        apiKey: "tenant-api-key",
        baseUrl: "https://public-api.granola.ai/v1",
        fetcher,
      }),
    );

    const result = await runner.run(
      {
        id: "call_filters",
        name: "granola_list_notes",
        arguments: {
          createdAfter: "2026-01-01",
          createdBefore: "2026-02-01T00:00:00Z",
          updatedAfter: "2026-01-15",
          folderId: "fol_4y6LduVdwSKC27",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
  });

  it("tolerates notes with a null title", async () => {
    const fetcher = mock(
      async () =>
        new Response(
          JSON.stringify({
            notes: [
              { id: "note_1", title: null, created_at: "2026-05-28T10:00:00Z" },
            ],
            hasMore: false,
          }),
          { status: 200 },
        ),
    );

    const runner = createToolRunner(
      createGranolaTools({
        apiKey: "tenant-api-key",
        baseUrl: "https://public-api.granola.ai/v1",
        fetcher,
      }),
    );

    const result = await runner.run(
      { id: "call_null_title", name: "granola_list_notes", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('"title": null');
  });

  it("gets a note transcript by id", async () => {
    const fetcher = mock(async (input: string, init: RequestInit) => {
      expect(String(input)).toBe(
        "https://public-api.granola.ai/v1/notes/note_1?include=transcript",
      );
      expect(init?.headers).toEqual({
        Authorization: "Bearer tenant-api-key",
        "Content-Type": "application/json",
      });

      return new Response(
        JSON.stringify({
          id: "note_1",
          title: "Sales Call",
          created_at: "2026-05-28T10:00:00Z",
          transcript: [
            {
              speaker: { source: "microphone", diarization_label: "Ada" },
              text: "We need the call notes.",
            },
          ],
        }),
        { status: 200 },
      );
    });

    const runner = createToolRunner(
      createGranolaTools({
        apiKey: "tenant-api-key",
        baseUrl: "https://public-api.granola.ai/v1",
        fetcher,
      }),
    );

    const result = await runner.run(
      {
        id: "call_2",
        name: "granola_get_note",
        arguments: { noteId: "note_1" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('"transcript"');
    expect(result.content).toContain("We need the call notes.");
  });

  it("lists folders using the page_size query parameter", async () => {
    const fetcher = mock(async (input: string, init: RequestInit) => {
      expect(String(input)).toBe(
        "https://public-api.granola.ai/v1/folders?page_size=5",
      );
      expect(init?.headers).toEqual({
        Authorization: "Bearer tenant-api-key",
        "Content-Type": "application/json",
      });

      return new Response(
        JSON.stringify({
          folders: [
            {
              id: "fol_4y6LduVdwSKC27",
              object: "folder",
              name: "Sales",
              parent_folder_id: null,
            },
          ],
          hasMore: false,
          cursor: null,
        }),
        { status: 200 },
      );
    });

    const runner = createToolRunner(
      createGranolaTools({
        apiKey: "tenant-api-key",
        baseUrl: "https://public-api.granola.ai/v1",
        fetcher,
      }),
    );

    const result = await runner.run(
      {
        id: "call_folders",
        name: "granola_list_folders",
        arguments: { limit: 5 },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('"name": "Sales"');
    expect(result.content).toContain('"parent_folder_id": null');
  });

  it("paginates folders with a cursor", async () => {
    const fetcher = mock(async (input: string) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1/folders");
      expect(url.searchParams.get("cursor")).toBe("next-page");

      return new Response(
        JSON.stringify({ folders: [], hasMore: false, cursor: null }),
        {
          status: 200,
        },
      );
    });

    const runner = createToolRunner(
      createGranolaTools({
        apiKey: "tenant-api-key",
        baseUrl: "https://public-api.granola.ai/v1",
        fetcher,
      }),
    );

    const result = await runner.run(
      {
        id: "call_folders_cursor",
        name: "granola_list_folders",
        arguments: { cursor: "next-page" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
  });

  it("surfaces Granola API failures as tool errors", async () => {
    const fetcher = mock(
      async (_input: string, _init: RequestInit) =>
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
        }),
    );

    const runner = createToolRunner(
      createGranolaTools({
        apiKey: "tenant-api-key",
        baseUrl: "https://public-api.granola.ai/v1",
        fetcher,
      }),
    );

    const result = await runner.run(
      {
        id: "call_3",
        name: "granola_list_notes",
        arguments: {},
      },
      new AbortController().signal,
    );

    expect(result).toEqual({
      callId: "call_3",
      content: "Granola API error: 401 Unauthorized",
      isError: true,
    });
  });

  it("requires a valid Granola base URL at construction", () => {
    expect(() =>
      createGranolaTools({
        apiKey: "tenant-api-key",
        baseUrl: "not a url",
      }),
    ).toThrow("Granola baseUrl must be a valid URL");
  });

  it("does not throw at construction when apiKey is empty (deferred to call time)", () => {
    expect(() =>
      createGranolaTools({
        apiKey: "",
        baseUrl: "https://public-api.granola.ai/v1",
      }),
    ).not.toThrow();
  });

  it("throws for a non-heartbeat caller when the key is missing", async () => {
    const fetcher = mock(async () => {
      throw new Error("should not be called");
    });

    const runner = createToolRunner(
      createGranolaTools({ apiKey: "", fetcher }),
    );

    const result = await runner.run(
      { id: "call_missing_key", name: "granola_list_notes", arguments: {} },
      new AbortController().signal,
    );

    expect(result).toEqual({
      callId: "call_missing_key",
      content: "Granola apiKey is required",
      isError: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("throws for a heartbeat caller too when the key is missing (nothing constructs the tool with an empty key)", async () => {
    const fetcher = mock(async () => {
      throw new Error("should not be called");
    });

    const runner = createToolRunner(
      createGranolaTools({ apiKey: "", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_missing_key_heartbeat",
        name: "granola_list_notes",
        arguments: { enabledSources: ["granola"] },
      },
      new AbortController().signal,
    );

    expect(result).toEqual({
      callId: "call_missing_key_heartbeat",
      content: "Granola apiKey is required",
      isError: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("degrades to skipped when the heartbeat caller's key is rejected with 401", async () => {
    const fetcher = mock(
      async () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
        }),
    );

    const runner = createToolRunner(
      createGranolaTools({ apiKey: "invalid-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_invalid_key_heartbeat",
        name: "granola_list_notes",
        arguments: { enabledSources: ["granola"] },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      notes: [],
      hasMore: false,
      skipped: true,
    });
  });

  it("does not degrade a non-auth failure for a heartbeat caller", async () => {
    const fetcher = mock(
      async () =>
        new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );

    const runner = createToolRunner(
      createGranolaTools({ apiKey: "tenant-api-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_server_error_heartbeat",
        name: "granola_list_notes",
        arguments: { enabledSources: ["granola"] },
      },
      new AbortController().signal,
    );

    expect(result).toEqual({
      callId: "call_server_error_heartbeat",
      content: "Granola API error: 500 boom",
      isError: true,
    });
  });

  it("still throws for granola_get_note when the key is missing, even with enabledSources present", async () => {
    const fetcher = mock(async () => {
      throw new Error("should not be called");
    });

    const runner = createToolRunner(
      createGranolaTools({ apiKey: "", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_get_note_missing_key",
        name: "granola_get_note",
        arguments: { noteId: "note_1" },
      },
      new AbortController().signal,
    );

    expect(result).toEqual({
      callId: "call_get_note_missing_key",
      content: "Granola apiKey is required",
      isError: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("still throws for granola_list_folders when the key is missing", async () => {
    const fetcher = mock(async () => {
      throw new Error("should not be called");
    });

    const runner = createToolRunner(
      createGranolaTools({ apiKey: "", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_list_folders_missing_key",
        name: "granola_list_folders",
        arguments: {},
      },
      new AbortController().signal,
    );

    expect(result).toEqual({
      callId: "call_list_folders_missing_key",
      content: "Granola apiKey is required",
      isError: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  function runGranola(
    response: unknown,
    request: { name: string; arguments: Record<string, unknown> },
    status = 200,
  ) {
    const fetcher = mock(
      async () => new Response(JSON.stringify(response), { status }),
    );
    const runner = createToolRunner(
      createGranolaTools({
        apiKey: "tenant-api-key",
        baseUrl: "https://public-api.granola.ai/v1",
        fetcher,
      }),
    );
    return runner.run({ id: "call", ...request }, new AbortController().signal);
  }

  it("errors when a note is missing a required id", async () => {
    const result = await runGranola(
      { notes: [{ title: "No id", created_at: "2026-01-01" }], hasMore: false },
      { name: "granola_list_notes", arguments: {} },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Granola response missing id");
  });

  it("errors when the notes list shape is invalid", async () => {
    const result = await runGranola(
      { notes: "not-an-array", hasMore: false },
      { name: "granola_list_notes", arguments: {} },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Granola response contains an invalid notes list",
    );
  });

  it("errors when a note value is not an object", async () => {
    const result = await runGranola(
      { notes: ["not-an-object"], hasMore: false },
      { name: "granola_list_notes", arguments: {} },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Granola response contains an invalid note",
    );
  });

  it("errors when a transcript item is malformed", async () => {
    const result = await runGranola(
      {
        id: "note_1",
        title: "Call",
        created_at: "2026-01-01",
        transcript: [{ speaker: { source: "microphone" } }],
      },
      { name: "granola_get_note", arguments: { noteId: "note_1" } },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Granola response contains an invalid transcript item",
    );
  });

  it("errors when a transcript speaker source is unknown", async () => {
    const result = await runGranola(
      {
        id: "note_1",
        title: "Call",
        created_at: "2026-01-01",
        transcript: [{ speaker: { source: "radio" }, text: "hi" }],
      },
      { name: "granola_get_note", arguments: { noteId: "note_1" } },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Granola response contains an invalid transcript speaker",
    );
  });

  it("omits the diarization label when absent", async () => {
    const result = await runGranola(
      {
        id: "note_1",
        title: "Call",
        created_at: "2026-01-01",
        transcript: [{ speaker: { source: "speaker" }, text: "no label" }],
      },
      { name: "granola_get_note", arguments: { noteId: "note_1" } },
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(String(result.content));
    expect(parsed.transcript[0]).toEqual({
      speaker: { source: "speaker" },
      text: "no label",
    });
  });

  it("requires the noteId argument", async () => {
    const result = await runGranola(
      {},
      { name: "granola_get_note", arguments: {} },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("noteId is required");
  });

  it("errors when the folders list shape is invalid", async () => {
    const result = await runGranola(
      { folders: "nope", hasMore: false },
      { name: "granola_list_folders", arguments: {} },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Granola response contains an invalid folders list",
    );
  });

  it("errors when a folder value is not an object", async () => {
    const result = await runGranola(
      { folders: [42], hasMore: false },
      { name: "granola_list_folders", arguments: {} },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Granola response contains an invalid folder",
    );
  });

  it("paginates notes with a cursor", async () => {
    const fetcher = mock(async (input: string) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("cursor")).toBe("next");
      return new Response(JSON.stringify({ notes: [], hasMore: false }), {
        status: 200,
      });
    });
    const runner = createToolRunner(
      createGranolaTools({
        apiKey: "tenant-api-key",
        baseUrl: "https://public-api.granola.ai/v1",
        fetcher,
      }),
    );

    const result = await runner.run(
      { id: "c", name: "granola_list_notes", arguments: { cursor: "next" } },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses the HTTP status text when the error body is empty", async () => {
    const fetcher = mock(
      async () =>
        new Response("", { status: 503, statusText: "Service Unavailable" }),
    );
    const runner = createToolRunner(
      createGranolaTools({
        apiKey: "tenant-api-key",
        baseUrl: "https://public-api.granola.ai/v1",
        fetcher,
      }),
    );

    const result = await runner.run(
      { id: "c", name: "granola_list_notes", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("Granola API error: 503 Service Unavailable");
  });

  it("surfaces a non-JSON error body verbatim", async () => {
    const fetcher = mock(
      async () =>
        new Response("upstream exploded", { status: 500, statusText: "" }),
    );
    const runner = createToolRunner(
      createGranolaTools({
        apiKey: "tenant-api-key",
        baseUrl: "https://public-api.granola.ai/v1",
        fetcher,
      }),
    );

    const result = await runner.run(
      { id: "c", name: "granola_list_notes", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("Granola API error: 500 upstream exploded");
  });
});

describe("GRANOLA_HUB_TOOLS", () => {
  it("builds tools from resolved credentials and honors baseURL override", () => {
    const entry = GRANOLA_HUB_TOOLS.granola_list_notes;
    expect(entry.providerName).toBe("granola");
    expect(entry.definition.name).toBe("granola_list_notes");

    const tools = entry.createTools({
      apiKey: "k",
      baseURL: "https://override.example/v1",
    });
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "granola_list_notes",
      "granola_get_note",
      "granola_list_folders",
    ]);
  });

  it("builds tools for get_note and list_folders entries without a baseURL", () => {
    const getTools = GRANOLA_HUB_TOOLS.granola_get_note.createTools({
      apiKey: "k",
    });
    const listTools = GRANOLA_HUB_TOOLS.granola_list_folders.createTools({
      apiKey: "k",
    });

    expect(getTools).toHaveLength(3);
    expect(listTools).toHaveLength(3);
    expect(GRANOLA_HUB_TOOLS.granola_get_note.providerName).toBe("granola");
    expect(GRANOLA_HUB_TOOLS.granola_list_folders.providerName).toBe("granola");
  });
});
