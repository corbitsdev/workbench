import { describe, expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import { createCatalogTools, LOAD_TOOLS_NAME, SEARCH_TOOLS_NAME } from "./tools";
import type { ToolCatalog, ToolExposureState } from "./schema";

const catalog: ToolCatalog = [
  {
    package: "attio",
    summary: "Attio CRM records.",
    tags: ["crm"],
    tools: [
      { name: "attio__query_records", description: "Query CRM records." },
      { name: "attio__create_note", description: "Create a note." },
    ],
  },
];

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "c1", name, arguments: args };
}

const signal = new AbortController().signal;

function setup() {
  const exposure: ToolExposureState = { exposed: new Set<string>() };
  const snapshots: string[][] = [];
  const runner = createCatalogTools({
    catalog,
    exposure,
    onExposureChanged: (exposed) => {
      snapshots.push([...exposed].sort());
    },
  });
  return { exposure, snapshots, runner };
}

describe("createCatalogTools onExposureChanged", () => {
  test("fires with the updated set when load_tools adds names", async () => {
    const { snapshots, runner } = setup();
    await runner.run(call(LOAD_TOOLS_NAME, { package: "attio" }), signal);
    expect(snapshots).toEqual([["attio__create_note", "attio__query_records"]]);
  });

  test("fires when search_tools auto-exposes a small match set", async () => {
    const { snapshots, runner } = setup();
    await runner.run(call(SEARCH_TOOLS_NAME, { query: "crm" }), signal);
    expect(snapshots).toEqual([["attio__create_note", "attio__query_records"]]);
  });

  test("does not fire when loading already-exposed names", async () => {
    const { snapshots, runner } = setup();
    await runner.run(
      call(LOAD_TOOLS_NAME, { names: ["attio__query_records"] }),
      signal,
    );
    await runner.run(
      call(LOAD_TOOLS_NAME, { names: ["attio__query_records"] }),
      signal,
    );
    expect(snapshots).toEqual([["attio__query_records"]]);
  });

  test("does not fire on an unknown package", async () => {
    const { snapshots, runner } = setup();
    await runner.run(call(LOAD_TOOLS_NAME, { package: "nope" }), signal);
    expect(snapshots).toEqual([]);
  });

  test("does not fire on a search with no auto-expose", async () => {
    const { snapshots, runner } = setup();
    await runner.run(call(SEARCH_TOOLS_NAME, { query: "zzz-nothing" }), signal);
    expect(snapshots).toEqual([]);
  });
});
