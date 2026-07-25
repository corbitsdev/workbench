// CL-4454: proves the real selector engine resolves each native `action`
// step's `input` straight to the exact call shape its tool schema expects —
// no argMap, no reshape layer. Unlike index.test.ts (which asserts on the
// *definition* shapes), this exercises the real `evaluateSelector` resolver
// against realistic step-output fixtures, the same empirical-shapes
// methodology used in last30days-research's resolution.test.ts.
import { describe, expect, test } from "bun:test";
import { evaluateSelector } from "@intx/workflow/runtime";

import { workflow } from "./index";

function actionInput(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "action") {
    throw new Error(
      `expected action primitive for "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive.input;
}

describe("CL-4454 competitor-analysis native action selector resolution", () => {
  test("scrape's input resolves intake's `url` verbatim as firecrawl_scrape's arg", () => {
    const resolved = evaluateSelector(actionInput("scrape"), {
      trigger: { payload: {} },
      steps: {
        intake: {
          output: {
            url: "https://acme.com",
            companyName: "Acme",
            focusNotes: "mid-market CRM",
          },
        },
      },
    } as never) as Record<string, unknown>;

    expect(resolved.url).toBe("https://acme.com");
    // Extra intake fields ride along harmlessly — firecrawl_scrape's arktype
    // schema ignores keys it does not declare.
    expect(resolved.companyName).toBe("Acme");
  });

  test("document's input merges intake's `url` and synthesize's `reply` — the tool's exact arg names, no rename", () => {
    const resolved = evaluateSelector(actionInput("document"), {
      trigger: { payload: {} },
      steps: {
        intake: { output: { url: "https://acme.com" } },
        synthesize: {
          output: { reply: '{"title":"Acme — competitor analysis"}' },
        },
      },
    } as never) as Record<string, unknown>;

    expect(resolved.url).toBe("https://acme.com");
    expect(resolved.reply).toBe('{"title":"Acme — competitor analysis"}');
  });

  test("packageArtifact's input merges document's { title, body }, review's output, and the literal { kind, jobLabel } — write_artifact's exact required args", () => {
    const resolved = evaluateSelector(actionInput("packageArtifact"), {
      trigger: { payload: {} },
      steps: {
        document: {
          output: {
            callId: "call_1",
            content: {
              title: "Acme — competitor analysis",
              body: "## Subject\nAcme sells CRM.",
            },
          },
        },
        review: { output: { approved: true } },
      },
    } as never) as Record<string, unknown>;

    expect(resolved.title).toBe("Acme — competitor analysis");
    expect(resolved.body).toBe("## Subject\nAcme sells CRM.");
    expect(resolved.kind).toBe("research");
    expect(resolved.jobLabel).toBe("Competitor analysis");
    expect(resolved.approved).toBe(true);
  });
});
