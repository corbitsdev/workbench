import { describe, expect, mock, test } from "bun:test";
import type { AgentTool } from "@intx/agent";
import type { ToolResult } from "@intx/types/runtime";

// Fake the two underlying tool packages at the module boundary so these tests
// exercise the REAL wrapper logic in tools.ts (the tolerant/fatal envelope
// behavior) without a network call. Each fake tool inspects its arguments to
// decide success vs. failure so a single mock module serves every test below.
function sumbleTool(
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

mock.module("@workbench/tools-sumble", () => ({
  createSumbleTools: () => [
    sumbleTool("sumble_resolve_organization", (args) => {
      if (args.identifier === "explodes.com") {
        return { callId: "c", isError: true, content: "resolve exploded" };
      }
      return { callId: "c", content: { slug: "acme" } };
    }),
    sumbleTool("sumble_search_people", (args) => {
      if (args.organizationSlug === "fail-slug") {
        return { callId: "c", isError: true, content: "people exploded" };
      }
      return {
        callId: "c",
        content: { people: [{ name: "Ada Lovelace" }], count: 1 },
      };
    }),
    sumbleTool("sumble_list_teams", (args) => {
      if (args.organizationSlug === "fail-slug") {
        throw new Error("teams exploded");
      }
      return { callId: "c", content: { teams: [{ name: "Platform" }] } };
    }),
    sumbleTool("sumble_list_jobs", (args) => {
      if (args.organizationSlug === "fail-slug") {
        return { callId: "c", isError: true, content: "jobs exploded" };
      }
      return { callId: "c", content: { jobs: [{ title: "Engineer" }] } };
    }),
    sumbleTool("sumble_search_signals", (args) => {
      if (args.organizationSlug === "fail-slug") {
        return { callId: "c", isError: true, content: "signals exploded" };
      }
      return { callId: "c", content: { signals: [{ label: "hiring" }] } };
    }),
  ],
}));

mock.module("@workbench/tools-x", () => ({
  createXTools: () => [
    sumbleTool("x_search", (args) => {
      if (args.query === "Fails Contact") {
        return { callId: "c", isError: true, content: "xai exploded" };
      }
      return { callId: "c", content: JSON.stringify([{ title: "a post" }]) };
    }),
  ],
}));

const { createSumbleAccountIntelTools } = await import("./tools");
const { toolManifestFile } = await import("./tool-manifest");

const SIGNAL = new AbortController().signal;

const CONFIG = {
  sumble: { apiKey: "sumble-key" },
};

const ENV_WITH_XAI: Record<string, unknown> = {
  "workbench.cred.xai": { apiKey: "x-key", baseURL: "https://x.example" },
};

const ENV_WITHOUT_XAI: Record<string, unknown> = {};

function fullTool(name: string, env: Record<string, unknown> = ENV_WITH_XAI) {
  const tool = createSumbleAccountIntelTools(CONFIG, env).find(
    (t) => t.definition.name === name,
  );
  if (!tool || tool.kind !== "full") {
    throw new Error(`${name} not registered as a full tool`);
  }
  return tool.handler;
}

describe("sumble_account_intel_format_report_document (CL-4232)", () => {
  test("pairs organizationDomain and reply into a title/body document", async () => {
    const handler = fullTool("sumble_account_intel_format_report_document");
    const result = await handler(
      {
        id: "document",
        name: "sumble_account_intel_format_report_document",
        arguments: {
          organizationDomain: "acme.com",
          reply: "## Account brief\n\nAcme is worth a look.",
        },
      },
      SIGNAL,
    );
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    expect(result.content).toEqual({
      title: "acme.com",
      body: "## Account brief\n\nAcme is worth a look.",
    });
  });

  test("returns isError when reply is missing", async () => {
    const handler = fullTool("sumble_account_intel_format_report_document");
    const result = await handler(
      {
        id: "document",
        name: "sumble_account_intel_format_report_document",
        arguments: { organizationDomain: "acme.com" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("reply is required");
  });

  test("returns isError when organizationDomain is missing", async () => {
    const handler = fullTool("sumble_account_intel_format_report_document");
    const result = await handler(
      {
        id: "document",
        name: "sumble_account_intel_format_report_document",
        arguments: { reply: "body" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("organizationDomain is required");
  });
});

describe("sumble_account_intel_resolve_organization — fatal passthrough", () => {
  test("renames organizationDomain to identifier and returns the resolved org verbatim", async () => {
    const handler = fullTool("sumble_account_intel_resolve_organization");
    const result = await handler(
      {
        id: "r",
        name: "sumble_account_intel_resolve_organization",
        arguments: { organizationDomain: "acme.com" },
      },
      SIGNAL,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({ slug: "acme" });
  });

  test("propagates isError:true when the underlying resolve fails — a real failure must still fail this step", async () => {
    const handler = fullTool("sumble_account_intel_resolve_organization");
    const result = await handler(
      {
        id: "r",
        name: "sumble_account_intel_resolve_organization",
        arguments: { organizationDomain: "explodes.com" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("resolve exploded");
  });
});

describe("sumble_account_intel_search_people (contacts) — fatal passthrough", () => {
  test("renames slug to organizationSlug and returns the people list verbatim", async () => {
    const handler = fullTool("sumble_account_intel_search_people");
    const result = await handler(
      {
        id: "c",
        name: "sumble_account_intel_search_people",
        arguments: { slug: "acme" },
      },
      SIGNAL,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({
      people: [{ name: "Ada Lovelace" }],
      count: 1,
    });
  });

  test("propagates isError:true when the underlying people search fails — contacts is load-bearing, must stay fatal", async () => {
    const handler = fullTool("sumble_account_intel_search_people");
    const result = await handler(
      {
        id: "c",
        name: "sumble_account_intel_search_people",
        arguments: { slug: "fail-slug" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("people exploded");
  });
});

describe("sumble_account_intel_list_teams / list_jobs / search_signals — tolerant facets", () => {
  test("teams: success returns the underlying teams list inside an ok envelope", async () => {
    const handler = fullTool("sumble_account_intel_list_teams");
    const result = await handler(
      {
        id: "t",
        name: "sumble_account_intel_list_teams",
        arguments: { slug: "acme" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toEqual({
      ok: true,
      data: { teams: [{ name: "Platform" }] },
    });
  });

  test("teams: a THROWN underlying error degrades to a completed step with an error envelope, not a failure", async () => {
    const handler = fullTool("sumble_account_intel_list_teams");
    const result = await handler(
      {
        id: "t",
        name: "sumble_account_intel_list_teams",
        arguments: { slug: "fail-slug" },
      },
      SIGNAL,
    );
    // The outer ToolResult MUST report isError:false — this is the field the
    // native action dispatch path (runDeterministicToolStep) inspects to
    // decide whether to throw. A tolerant facet never sets it true.
    expect(result.isError).toBe(false);
    expect(result.content).toEqual({ ok: false, error: "teams exploded" });
  });

  test("jobs: an underlying isError:true result degrades to an ok:false envelope, not an outer isError", async () => {
    const handler = fullTool("sumble_account_intel_list_jobs");
    const result = await handler(
      {
        id: "j",
        name: "sumble_account_intel_list_jobs",
        arguments: { slug: "fail-slug" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toEqual({ ok: false, error: "jobs exploded" });
  });

  test("signals: an underlying isError:true result degrades to an ok:false envelope, not an outer isError", async () => {
    const handler = fullTool("sumble_account_intel_search_signals");
    const result = await handler(
      {
        id: "s",
        name: "sumble_account_intel_search_signals",
        arguments: { slug: "fail-slug" },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toEqual({ ok: false, error: "signals exploded" });
  });

  test("missing slug degrades to an ok:false envelope rather than failing", async () => {
    const handler = fullTool("sumble_account_intel_list_teams");
    const result = await handler(
      { id: "t", name: "sumble_account_intel_list_teams", arguments: {} },
      SIGNAL,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toEqual({ ok: false, error: "slug is required" });
  });
});

describe("sumble_account_intel_enrich_contacts — folds the former map, tolerant per contact", () => {
  test("enriches every contact and reports one failure without failing the others", async () => {
    const handler = fullTool("sumble_account_intel_enrich_contacts");
    const result = await handler(
      {
        id: "e",
        name: "sumble_account_intel_enrich_contacts",
        arguments: {
          people: [{ name: "Ada Lovelace" }, { name: "Fails Contact" }],
        },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(false);
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    const { people } = result.content as { people: unknown[] };
    // `runTolerantTool` (`@workbench/tool-credentials/tolerance-envelope-
    // dispatch`) parses a successful `kind: "string"` tool's JSON-string
    // content into real data via the shared `parseToleranceEnvelope` — this
    // wrapper no longer hands the caller a still-JSON-encoded string.
    expect(people).toEqual([
      {
        ok: true,
        data: [{ title: "a post" }],
        name: "Ada Lovelace",
      },
      { ok: false, error: "xai exploded", name: "Fails Contact" },
    ]);
  });

  test("an empty people array produces an empty result set, not a failure", async () => {
    const handler = fullTool("sumble_account_intel_enrich_contacts");
    const result = await handler(
      {
        id: "e",
        name: "sumble_account_intel_enrich_contacts",
        arguments: { people: [] },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toEqual({ people: [] });
  });

  test("a tenant with no xai credential configured at all degrades every contact instead of failing the run or dropping the tool package", async () => {
    // Regression guard for the eager-construction trap: `xai` used to be
    // resolved eagerly in interchange-tools.ts's factory, so a tenant with
    // no xAI credential threw `ToolCredentialMissingError` while
    // CONSTRUCTING the whole sumble-account-intel package — not just this
    // tool. Resolving it lazily here means the package still builds, this
    // handler still completes, and only the contacts themselves report the
    // missing credential.
    const handler = fullTool(
      "sumble_account_intel_enrich_contacts",
      ENV_WITHOUT_XAI,
    );
    const result = await handler(
      {
        id: "e",
        name: "sumble_account_intel_enrich_contacts",
        arguments: {
          people: [{ name: "Ada Lovelace" }, { name: "Grace Hopper" }],
        },
      },
      SIGNAL,
    );
    expect(result.isError).toBe(false);
    if (typeof result.content === "string") {
      throw new Error("expected object content");
    }
    const { people } = result.content as {
      people: { ok: boolean; error: string }[];
    };
    expect(people).toHaveLength(2);
    for (const person of people) {
      expect(person.ok).toBe(false);
      expect(person.error).toContain("xai");
    }
  });

  test("a missing xai credential does not prevent the sumble-backed tools from being registered and working", async () => {
    const handler = fullTool(
      "sumble_account_intel_resolve_organization",
      ENV_WITHOUT_XAI,
    );
    const result = await handler(
      {
        id: "r",
        name: "sumble_account_intel_resolve_organization",
        arguments: { organizationDomain: "acme.com" },
      },
      SIGNAL,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({ slug: "acme" });
  });
});

describe("tool-manifest completeness", () => {
  test("every registered tool name is declared in the hand-authored manifest", () => {
    const runtimeNames = createSumbleAccountIntelTools(CONFIG, ENV_WITH_XAI)
      .map((tool) => tool.definition.name)
      .sort();
    const factory = toolManifestFile.factories[0];
    if (!factory) {
      throw new Error(
        "expected the sumble-account-intel manifest to declare a factory",
      );
    }
    const manifestNames = [...factory.bareToolNames].sort();
    expect(manifestNames).toEqual(runtimeNames);
  });
});
