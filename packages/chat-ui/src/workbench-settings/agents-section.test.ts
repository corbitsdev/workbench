// CL-6215 EMIL #8: the History table's raw backend commit message names
// the agent in full-sentence form and repeats verbatim across seed rows —
// these are the pure pieces that turn it into a short per-row change
// summary and soften repeated runs, independent of the DOM-mounted
// composition tests in `test/agents-section.test.tsx`.

import { describe, expect, test } from "bun:test";

import {
  collapseHistoryVersions,
  summarizeHistoryMessage,
} from "./agents-section";
import type { AgentVersion } from "../api";

function version(overrides: Partial<AgentVersion> = {}): AgentVersion {
  return {
    commitSha: "sha1",
    message: "Update agent instructions for Myra",
    author: "Ada",
    committedAtIso: "2026-08-01T00:00:00.000Z",
    current: false,
    ...overrides,
  };
}

describe("summarizeHistoryMessage", () => {
  test("instructions and skills updates read as a short summary, not the full sentence", () => {
    expect(summarizeHistoryMessage("Update agent instructions for Myra")).toBe(
      "Instructions updated",
    );
    expect(summarizeHistoryMessage("Update agent skills for Myra")).toBe(
      "Skills updated",
    );
  });

  test("a capability addition names what was added", () => {
    expect(summarizeHistoryMessage("Add @corbits/github-tools to Myra")).toBe(
      "Added tool: @corbits/github-tools",
    );
    expect(summarizeHistoryMessage("Add research skill to Myra")).toBe(
      "Added skill: research",
    );
    expect(
      summarizeHistoryMessage("Set Myra's model to anthropic/claude-sonnet"),
    ).toBe("Model set to anthropic/claude-sonnet");
  });

  test("restore and creation read as their own summaries", () => {
    expect(summarizeHistoryMessage("Restore agent Myra to a1b2c3d4")).toBe(
      "Restored from history",
    );
    expect(summarizeHistoryMessage("Define agent Myra")).toBe("Agent created");
  });

  test("an unrecognized message falls back to itself rather than going blank", () => {
    expect(summarizeHistoryMessage("Something new entirely")).toBe(
      "Something new entirely",
    );
  });
});

describe("collapseHistoryVersions", () => {
  test("consecutive identical seed rows collapse into one, with a repeat count", () => {
    const rows = collapseHistoryVersions([
      version({ commitSha: "sha3", current: true }),
      version({ commitSha: "sha2" }),
      version({ commitSha: "sha1" }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      commitSha: "sha3",
      current: true,
      repeatCount: 1,
    });
    expect(rows[1]).toMatchObject({
      commitSha: "sha2",
      summary: "Instructions updated",
      repeatCount: 2,
    });
  });

  test("the current row never collapses into a neighbor", () => {
    const rows = collapseHistoryVersions([
      version({ commitSha: "sha2", current: true }),
      version({ commitSha: "sha1", current: false }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.current).toBe(true);
    expect(rows[0]?.repeatCount).toBe(1);
  });

  test("a different author or change never collapses together", () => {
    const rows = collapseHistoryVersions([
      version({ commitSha: "sha2", message: "Update agent skills for Myra" }),
      version({
        commitSha: "sha1",
        message: "Update agent instructions for Myra",
      }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.repeatCount)).toEqual([1, 1]);
  });
});
