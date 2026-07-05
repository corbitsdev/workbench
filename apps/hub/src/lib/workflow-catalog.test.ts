import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowCatalogKinds } from "./workflow-catalog";
import { embeddedWorkflowDefsDir } from "./workflow-defs-embedded";

let dir: string;
let realKinds: Set<string>;

// Copy two real committed defs into a scratch dir alongside intentional junk,
// so the schema parse is exercised against genuine definitions (a minimal
// hand-written fixture would fail the strict envelope schema and mask the test).
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "wf-catalog-"));
  const src = embeddedWorkflowDefsDir();
  const files = (await readdir(src))
    .filter((f) => f.endsWith(".json"))
    .slice(0, 2);
  realKinds = new Set();
  for (const f of files) {
    await copyFile(join(src, f), join(dir, f));
    const parsed = JSON.parse(await readFile(join(src, f), "utf8")) as {
      kind: string;
    };
    realKinds.add(parsed.kind);
  }
  // Malformed JSON must be skipped, not poison the whole allowlist.
  await writeFile(join(dir, "broken.json"), "{ not json");
  // Non-json files are ignored.
  await writeFile(join(dir, "notes.txt"), "ignore me");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadWorkflowCatalogKinds", () => {
  it("returns the kind of every well-formed committed def, skipping junk", async () => {
    const kinds = await loadWorkflowCatalogKinds(dir);
    expect(kinds).toEqual(realKinds);
    expect(kinds.size).toBe(2);
  });

  it("returns an empty set when the directory does not exist", async () => {
    const kinds = await loadWorkflowCatalogKinds(join(dir, "nope"));
    expect(kinds.size).toBe(0);
  });
});
