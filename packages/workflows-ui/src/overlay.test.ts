import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveDisplayFlow } from "./derive-display-flow";
import { applyDisplayOverlay } from "./overlay";
import type { DisplayFlow } from "./types";

const WORKFLOW_DEFS_DIR = join(
  import.meta.dir,
  "../../../apps/hub/generated/workflow-defs",
);

function loadFlow(kind: string): DisplayFlow {
  const raw = JSON.parse(
    readFileSync(join(WORKFLOW_DEFS_DIR, `${kind}.json`), "utf8"),
  );
  return deriveDisplayFlow(raw);
}

describe("applyDisplayOverlay", () => {
  test("groups process-granola-call's six runtime steps into its declared four display steps", () => {
    const flow = loadFlow("process-granola-call");

    const overlaid = applyDisplayOverlay(flow, {
      groups: [
        { key: "fetch", label: "Fetch the transcript", steps: ["fetch"] },
        {
          key: "transcript",
          label: "Save the raw transcript",
          steps: ["transcript"],
        },
        {
          key: "extract",
          label: "Extract working notes",
          steps: ["extract", "processed"],
          activityLabel: "Extracting working notes",
        },
        {
          key: "finalize",
          label: "Verify and write call notes",
          steps: ["finalize", "persist"],
          activityLabel: "Writing the call notes",
        },
      ],
    });

    expect(overlaid.groups.map((g) => g.key)).toEqual([
      "fetch",
      "transcript",
      "extract",
      "finalize",
    ]);
    expect(overlaid.groups[2]).toMatchObject({
      key: "extract",
      stepIds: ["extract", "processed"],
      activityLabel: "Extracting working notes",
    });
  });

  test("throws on an overlay group referencing an unknown step id", () => {
    const flow = loadFlow("granola-call");

    expect(() =>
      applyDisplayOverlay(flow, {
        groups: [
          {
            key: "bogus",
            label: "Bogus group",
            steps: ["discover", "this-step-does-not-exist"],
          },
        ],
      }),
    ).toThrow(/this-step-does-not-exist/);
  });
});
