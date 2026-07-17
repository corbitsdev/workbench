import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EXPOSURE_STATE_FILE,
  filterExposureToCatalog,
  persistExposure,
  readPersistedExposure,
} from "./exposure-persistence";
import type { ToolCatalog } from "./schema";

let dir: string;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wb-exposure-"));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe("persistExposure / readPersistedExposure", () => {
  test("round-trips a set of exposed names, sorted", async () => {
    await persistExposure(dir, new Set(["b__two", "a__one"]));
    const result = await readPersistedExposure(dir);
    expect(result.exposed).toEqual(["a__one", "b__two"]);
    expect(result.corrupt).toBeUndefined();
  });

  test("missing file reads as empty, not corrupt", async () => {
    const result = await readPersistedExposure(dir);
    expect(result.exposed).toEqual([]);
    expect(result.corrupt).toBeUndefined();
  });

  test("missing directory reads as empty, not corrupt", async () => {
    const result = await readPersistedExposure(path.join(dir, "nope"));
    expect(result.exposed).toEqual([]);
    expect(result.corrupt).toBeUndefined();
  });

  test("unparseable file reads as empty and reports corruption with the file path", async () => {
    await fs.promises.writeFile(
      path.join(dir, EXPOSURE_STATE_FILE),
      "not json{{",
    );
    const result = await readPersistedExposure(dir);
    expect(result.exposed).toEqual([]);
    expect(result.corrupt).toContain(EXPOSURE_STATE_FILE);
  });

  test("valid JSON with the wrong shape reads as empty and reports corruption", async () => {
    await fs.promises.writeFile(
      path.join(dir, EXPOSURE_STATE_FILE),
      JSON.stringify({ exposed: "attio__query_records" }),
    );
    const result = await readPersistedExposure(dir);
    expect(result.exposed).toEqual([]);
    expect(result.corrupt).toContain(EXPOSURE_STATE_FILE);
  });

  test("later persist overwrites earlier, atomically (no tmp file left)", async () => {
    await persistExposure(dir, new Set(["a__one"]));
    await persistExposure(dir, new Set(["a__one", "c__three"]));
    const result = await readPersistedExposure(dir);
    expect(result.exposed).toEqual(["a__one", "c__three"]);
    const entries = await fs.promises.readdir(dir);
    expect(entries).toEqual([EXPOSURE_STATE_FILE]);
  });

  test("concurrent persists leave no tmp files and a readable final state", async () => {
    await Promise.all([
      persistExposure(dir, new Set(["a__one"])),
      persistExposure(dir, new Set(["b__two"])),
      persistExposure(dir, new Set(["c__three"])),
    ]);
    const entries = await fs.promises.readdir(dir);
    expect(entries).toEqual([EXPOSURE_STATE_FILE]);
    const result = await readPersistedExposure(dir);
    expect(result.corrupt).toBeUndefined();
    expect(result.exposed.length).toBe(1);
  });

  test("creates the directory when absent", async () => {
    const nested = path.join(dir, "deep", "store");
    await persistExposure(nested, new Set(["a__one"]));
    expect((await readPersistedExposure(nested)).exposed).toEqual(["a__one"]);
  });
});

describe("filterExposureToCatalog", () => {
  const catalog: ToolCatalog = [
    {
      package: "attio",
      summary: "Attio CRM records.",
      tags: ["crm"],
      tools: [
        { name: "attio__query_records", description: "Query CRM records." },
      ],
    },
  ];

  test("keeps only currently-catalogued names", () => {
    const kept = filterExposureToCatalog(
      ["attio__query_records", "retired__tool"],
      catalog,
    );
    expect(kept).toEqual(["attio__query_records"]);
  });

  test("empty catalog keeps nothing", () => {
    expect(filterExposureToCatalog(["attio__query_records"], [])).toEqual([]);
  });
});
