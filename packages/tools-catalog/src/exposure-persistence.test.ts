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
    const names = await readPersistedExposure(dir);
    expect(names).toEqual(["a__one", "b__two"]);
  });

  test("missing file reads as empty", async () => {
    const names = await readPersistedExposure(dir);
    expect(names).toEqual([]);
  });

  test("missing directory reads as empty", async () => {
    const names = await readPersistedExposure(path.join(dir, "nope"));
    expect(names).toEqual([]);
  });

  test("corrupt file throws with the file path in the message", async () => {
    await fs.promises.writeFile(
      path.join(dir, EXPOSURE_STATE_FILE),
      "not json{{",
    );
    await expect(readPersistedExposure(dir)).rejects.toThrow(
      EXPOSURE_STATE_FILE,
    );
  });

  test("valid JSON with the wrong shape throws", async () => {
    await fs.promises.writeFile(
      path.join(dir, EXPOSURE_STATE_FILE),
      JSON.stringify({ exposed: "attio__query_records" }),
    );
    await expect(readPersistedExposure(dir)).rejects.toThrow();
  });

  test("later persist overwrites earlier, atomically (no tmp file left)", async () => {
    await persistExposure(dir, new Set(["a__one"]));
    await persistExposure(dir, new Set(["a__one", "c__three"]));
    const names = await readPersistedExposure(dir);
    expect(names).toEqual(["a__one", "c__three"]);
    const entries = await fs.promises.readdir(dir);
    expect(entries).toEqual([EXPOSURE_STATE_FILE]);
  });

  test("creates the directory when absent", async () => {
    const nested = path.join(dir, "deep", "store");
    await persistExposure(nested, new Set(["a__one"]));
    expect(await readPersistedExposure(nested)).toEqual(["a__one"]);
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
