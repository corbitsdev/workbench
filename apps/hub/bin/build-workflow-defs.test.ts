import { describe, expect, it } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { embeddedWorkflowDefsDir } from "../src/lib/workflow-defs-embedded";
import {
  serializeEmbeddedJson,
  serializeWorkflowDef,
  workflowKinds,
} from "./build-workflow-defs";

// Drift gate (CL-2593): the committed generated/workflow-defs/<kind>.json must
// match what serializing the live workflow source produces right now. If a
// workflow def changed and `bun run build:workflow-defs` was not re-run, this
// fails — so a stale committed def can never reach a boot-time publish.
describe("committed workflow defs are in sync with source", () => {
  it("has exactly one committed file per workflow kind", async () => {
    const committed = (await readdir(embeddedWorkflowDefsDir()))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    expect(committed).toEqual(workflowKinds());
  });

  for (const kind of workflowKinds()) {
    it(`${kind}.json matches the serialized live def`, async () => {
      const expected = serializeEmbeddedJson(await serializeWorkflowDef(kind));
      const actual = await readFile(
        join(embeddedWorkflowDefsDir(), `${kind}.json`),
        "utf8",
      );
      // If this fails, run `bun run build:workflow-defs` and commit the result.
      expect(actual).toBe(expected);
    });
  }
});
