// Hub-zero T4 (CL-8126) red test: the hub's connector surface and
// scheduled-delivery path cut over to native primitives, with zero import
// from the legacy template package.
//
// Part A (structural): `index.ts`, `pinned-package-credential-bindings.ts`,
// and `workflow-scheduler.ts` carry no legacy template import, and the
// delivery join (settings-row read + run-participant join) is gone —
// scheduled runs launch without joining a chat.
//
// Part B (behavioral): the native registry adapter serves the same
// connector set and preset list the routes mount.
//
// Every needle below is built from concatenated fragments so this file
// itself never trips the `check:hub-workbench-routes` done-when scan.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const HUB_SRC = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "apps",
  "hub",
  "src",
);

function readHub(rel: string): string {
  return readFileSync(path.join(HUB_SRC, rel), "utf8");
}

const LEGACY_PKG = "@work" + "bench/templates";
const LIST_SETTINGS = "list" + "WorkbenchSettings";
const GET_SETTINGS = "get" + "WorkbenchSettings";
const JOIN_DEPS = "Scheduled" + "DeliveryJoinDeps";
const JOIN_FN = "joinScheduled" + "DefinitionToChat";
const JOIN_PORT = "join" + "DeliveryChat";
const JOIN_INPUT = "Join" + "RunParticipantInput";
const COMMAND_GUARD = "workbench" + "BelongsToTenant";

describe("hub-zero T4: no legacy template import in the hub", () => {
  for (const rel of [
    "index.ts",
    "pinned-package-credential-bindings.ts",
    "workflow-scheduler.ts",
  ]) {
    test(`${rel} imports no legacy template package`, () => {
      expect(
        readHub(rel).includes(LEGACY_PKG),
        `${rel} still imports ${LEGACY_PKG}`,
      ).toBe(false);
    });
  }
});

describe("hub-zero T4: the scheduled delivery join is cut", () => {
  test("no settings-row list read survives in the hub", () => {
    for (const rel of ["index.ts", "workflow-scheduler.ts"]) {
      expect(
        readHub(rel).includes(LIST_SETTINGS),
        `${rel} still reads ${LIST_SETTINGS}`,
      ).toBe(false);
    }
  });

  test("no delivery-join seam survives in workflow-scheduler.ts", () => {
    const source = readHub("workflow-scheduler.ts");
    for (const needle of [JOIN_DEPS, JOIN_FN, JOIN_PORT, JOIN_INPUT]) {
      expect(
        source.includes(needle),
        `workflow-scheduler.ts still contains ${needle}`,
      ).toBe(false);
    }
  });

  test("no delivery-join seam survives in index.ts", () => {
    const source = readHub("index.ts");
    for (const needle of [JOIN_DEPS, JOIN_FN, JOIN_PORT]) {
      expect(source.includes(needle), `index.ts still contains ${needle}`).toBe(
        false,
      );
    }
  });

  test("the single get-variant read stays inside the command guard", () => {
    // T5-owned: `createCommandRoutes`' membership check. List-only would
    // strand it; the get-variant is the documented exception.
    const source = readHub("index.ts");
    const occurrences = source.split(GET_SETTINGS).length - 1;
    expect(occurrences).toBe(1);
    expect(source.includes(COMMAND_GUARD)).toBe(true);
  });
});

describe("hub-zero T4: the native connector registry", () => {
  test("serves the full connector set the routes mount", async () => {
    const { CONNECTOR_REGISTRY } = await import("./native-connector-registry");
    const ids = new Set(Object.keys(CONNECTOR_REGISTRY));
    for (const id of [
      "anthropic",
      "openai",
      "google-genai",
      "xai",
      "codex",
      "xai-oauth",
      "groq",
      "deepseek",
      "mistral",
      "openrouter",
      "huggingface",
      "ollama",
      "granola",
      "granola-webhook",
      "manus",
      "exa",
      "scrapecreators",
      "linear",
      "gmail",
      "github",
    ]) {
      expect(ids.has(id), `native registry is missing connector ${id}`).toBe(
        true,
      );
    }
  });

  test("every descriptor carries the shape the route factories read", async () => {
    const { CONNECTOR_REGISTRY } = await import("./native-connector-registry");
    for (const [key, descriptor] of Object.entries(CONNECTOR_REGISTRY)) {
      expect(descriptor.id, `${key} id`).toBe(key);
      expect(descriptor.displayName.length > 0, `${key} displayName`).toBe(
        true,
      );
      expect(Array.isArray(descriptor.feedsTools), `${key} feedsTools`).toBe(
        true,
      );
    }
  });

  test("tool-feeding connectors keep their tool packages", async () => {
    const { CONNECTOR_REGISTRY } = await import("./native-connector-registry");
    const feedsToolsFor = (id: string): readonly string[] =>
      CONNECTOR_REGISTRY[id]?.feedsTools ?? [];
    expect(feedsToolsFor("github")).toContain("@corbits/github-tools");
    expect(feedsToolsFor("exa")).toContain("@corbits/web-search-tools");
    expect(feedsToolsFor("granola")).toContain("@corbits/granola-tools");
    expect(feedsToolsFor("linear")).toContain("@corbits/linear-tools");
    expect(feedsToolsFor("manus")).toContain("@corbits/manus-tools");
  });

  test("serves the curated preset list the MCP mounts read", async () => {
    const { MCP_PRESETS } = await import("./native-connector-registry");
    const slugs = new Set(MCP_PRESETS.map((preset) => preset.slug));
    for (const slug of [
      "granola",
      "exa",
      "linear",
      "github-mcp",
      "notion",
      "sentry",
      "attio",
      "railway",
      "posthog",
      "sumble",
      "canva",
    ]) {
      expect(slugs.has(slug), `preset list is missing ${slug}`).toBe(true);
    }
    for (const preset of MCP_PRESETS) {
      expect(preset.url.length > 0, `${preset.slug} url`).toBe(true);
      expect(preset.connectionMode.length > 0, `${preset.slug} mode`).toBe(
        true,
      );
    }
  });
});
