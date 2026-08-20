import { describe, expect, test } from "bun:test";

import type { PlannerInventory } from "./inventory";
import {
  parseTaskSpec,
  validateTaskSpecAgainstInventory,
  PlannerReferenceOutOfInventoryError,
  PlannerReplyUnparseableError,
} from "./task-spec";

const INVENTORY: PlannerInventory = {
  agents: [
    { id: "wfd_summarizer", name: "summarizer", displayName: "Summarizer" },
  ],
  toolPackages: [
    {
      name: "@corbits/granola-tools",
      connectorId: "granola",
      credentialBinding: {
        package: "@corbits/granola-tools",
        handle: "granola",
        provider: "granola",
        locator: "tenant",
      },
    },
  ],
  skills: [{ name: "incident-review", description: "Reviews incidents" }],
  memoryAvailable: true,
  models: [{ canonicalName: "anthropic/claude-sonnet-5" }],
};

describe("parseTaskSpec", () => {
  test("parses an in-inventory {use} reply", () => {
    const spec = parseTaskSpec(
      JSON.stringify({
        kind: "task",
        use: "wfd_summarizer",
        refinedOutcome: "Summarize the doc",
      }),
    );
    expect(spec).toEqual({
      kind: "task",
      use: "wfd_summarizer",
      refinedOutcome: "Summarize the doc",
    });
  });

  test("parses an in-inventory {create} reply", () => {
    const spec = parseTaskSpec(
      JSON.stringify({
        kind: "task",
        create: {
          name: "Incident bot",
          systemPrompt: "You review incidents.",
          toolPackagePins: ["@corbits/granola-tools"],
          skills: ["incident-review"],
          modelPreference: "anthropic/claude-sonnet-5",
        },
        refinedOutcome: "Review the latest incident",
      }),
    );
    expect("create" in spec).toBe(true);
  });

  test("malformed JSON fails closed", () => {
    expect(() => parseTaskSpec("not json{{{")).toThrow(
      PlannerReplyUnparseableError,
    );
  });

  test("JSON that matches neither union branch fails closed", () => {
    expect(() => parseTaskSpec(JSON.stringify({ hello: "world" }))).toThrow(
      PlannerReplyUnparseableError,
    );
  });

  test("missing refinedOutcome fails closed", () => {
    expect(() =>
      parseTaskSpec(JSON.stringify({ use: "wfd_summarizer" })),
    ).toThrow(PlannerReplyUnparseableError);
  });

  test("a reply missing the kind discriminant fails closed", () => {
    expect(() =>
      parseTaskSpec(
        JSON.stringify({
          use: "wfd_summarizer",
          refinedOutcome: "Summarize the doc",
        }),
      ),
    ).toThrow(PlannerReplyUnparseableError);
  });

  test('a reply with an unrecognized "kind" fails closed', () => {
    expect(() =>
      parseTaskSpec(
        JSON.stringify({
          kind: "workflow",
          use: "wfd_summarizer",
          refinedOutcome: "Summarize the doc",
        }),
      ),
    ).toThrow(PlannerReplyUnparseableError);
  });

  test('parses a "chain" reply whose steps are each a valid {use}/{create} shape', () => {
    const spec = parseTaskSpec(
      JSON.stringify({
        kind: "chain",
        steps: [
          { use: "wfd_summarizer", refinedOutcome: "Summarize the doc" },
          {
            create: {
              name: "Incident bot",
              systemPrompt: "You review incidents.",
              toolPackagePins: ["@corbits/granola-tools"],
              skills: ["incident-review"],
            },
            refinedOutcome: "Review the summary",
          },
        ],
      }),
    );
    expect(spec).toEqual({
      kind: "chain",
      steps: [
        { use: "wfd_summarizer", refinedOutcome: "Summarize the doc" },
        {
          create: {
            name: "Incident bot",
            systemPrompt: "You review incidents.",
            toolPackagePins: ["@corbits/granola-tools"],
            skills: ["incident-review"],
          },
          refinedOutcome: "Review the summary",
        },
      ],
    });
  });

  test("a chain with only one step fails closed — a chain is at least 2 steps", () => {
    expect(() =>
      parseTaskSpec(
        JSON.stringify({
          kind: "chain",
          steps: [
            { use: "wfd_summarizer", refinedOutcome: "Summarize the doc" },
          ],
        }),
      ),
    ).toThrow(PlannerReplyUnparseableError);
  });

  test("a chain with zero steps fails closed", () => {
    expect(() =>
      parseTaskSpec(JSON.stringify({ kind: "chain", steps: [] })),
    ).toThrow(PlannerReplyUnparseableError);
  });

  test("a chain with 6 steps fails closed — bounded at 5", () => {
    expect(() =>
      parseTaskSpec(
        JSON.stringify({
          kind: "chain",
          steps: Array.from({ length: 6 }, (_unused, index) => ({
            use: "wfd_summarizer",
            refinedOutcome: `Step ${String(index + 1)}`,
          })),
        }),
      ),
    ).toThrow(PlannerReplyUnparseableError);
  });

  test("a chain with 5 steps is accepted — the upper bound is inclusive", () => {
    expect(() =>
      parseTaskSpec(
        JSON.stringify({
          kind: "chain",
          steps: Array.from({ length: 5 }, (_unused, index) => ({
            use: "wfd_summarizer",
            refinedOutcome: `Step ${String(index + 1)}`,
          })),
        }),
      ),
    ).not.toThrow();
  });

  test("a chain step missing refinedOutcome fails closed", () => {
    expect(() =>
      parseTaskSpec(
        JSON.stringify({
          kind: "chain",
          steps: [
            { use: "wfd_summarizer" },
            { use: "wfd_summarizer", refinedOutcome: "Summarize the doc" },
          ],
        }),
      ),
    ).toThrow(PlannerReplyUnparseableError);
  });

  test("the unparseable error excerpts, never dumps, the raw reply", () => {
    const huge = "x".repeat(5000);
    try {
      parseTaskSpec(huge);
      throw new Error("expected parseTaskSpec to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PlannerReplyUnparseableError);
      expect((err as Error).message.length).toBeLessThan(huge.length);
    }
  });
});

describe("validateTaskSpecAgainstInventory", () => {
  test("an in-inventory {use} spec passes", () => {
    expect(() =>
      validateTaskSpecAgainstInventory(
        { kind: "task", use: "wfd_summarizer", refinedOutcome: "Summarize" },
        INVENTORY,
      ),
    ).not.toThrow();
  });

  test("an in-inventory {create} spec passes", () => {
    expect(() =>
      validateTaskSpecAgainstInventory(
        {
          kind: "task",
          create: {
            name: "Incident bot",
            systemPrompt: "You review incidents.",
            toolPackagePins: ["@corbits/granola-tools"],
            skills: ["incident-review"],
            modelPreference: "anthropic/claude-sonnet-5",
          },
          refinedOutcome: "Review the latest incident",
        },
        INVENTORY,
      ),
    ).not.toThrow();
  });

  test("an out-of-inventory agent id fails closed", () => {
    expect(() =>
      validateTaskSpecAgainstInventory(
        { kind: "task", use: "wfd_unknown", refinedOutcome: "Summarize" },
        INVENTORY,
      ),
    ).toThrow(PlannerReferenceOutOfInventoryError);
  });

  test("an out-of-inventory tool package fails closed", () => {
    expect(() =>
      validateTaskSpecAgainstInventory(
        {
          kind: "task",
          create: {
            name: "Bot",
            systemPrompt: "Prompt.",
            toolPackagePins: ["@corbits/unknown-tools"],
            skills: [],
          },
          refinedOutcome: "Do it",
        },
        INVENTORY,
      ),
    ).toThrow(PlannerReferenceOutOfInventoryError);
  });

  test("an out-of-inventory skill fails closed", () => {
    expect(() =>
      validateTaskSpecAgainstInventory(
        {
          kind: "task",
          create: {
            name: "Bot",
            systemPrompt: "Prompt.",
            toolPackagePins: [],
            skills: ["unknown-skill"],
          },
          refinedOutcome: "Do it",
        },
        INVENTORY,
      ),
    ).toThrow(PlannerReferenceOutOfInventoryError);
  });

  test("an out-of-inventory model fails closed", () => {
    expect(() =>
      validateTaskSpecAgainstInventory(
        {
          kind: "task",
          create: {
            name: "Bot",
            systemPrompt: "Prompt.",
            toolPackagePins: [],
            skills: [],
            modelPreference: "openai/gpt-unknown",
          },
          refinedOutcome: "Do it",
        },
        INVENTORY,
      ),
    ).toThrow(PlannerReferenceOutOfInventoryError);
  });

  test("a chain whose every step is in-inventory passes", () => {
    expect(() =>
      validateTaskSpecAgainstInventory(
        {
          kind: "chain",
          steps: [
            { use: "wfd_summarizer", refinedOutcome: "Summarize" },
            {
              create: {
                name: "Incident bot",
                systemPrompt: "You review incidents.",
                toolPackagePins: ["@corbits/granola-tools"],
                skills: ["incident-review"],
              },
              refinedOutcome: "Review the summary",
            },
          ],
        },
        INVENTORY,
      ),
    ).not.toThrow();
  });

  test("a chain whose FIRST step is out of inventory fails closed", () => {
    expect(() =>
      validateTaskSpecAgainstInventory(
        {
          kind: "chain",
          steps: [
            { use: "wfd_unknown", refinedOutcome: "Summarize" },
            { use: "wfd_summarizer", refinedOutcome: "Review" },
          ],
        },
        INVENTORY,
      ),
    ).toThrow(PlannerReferenceOutOfInventoryError);
  });

  test("a chain whose LAST step is out of inventory fails closed — no step is trusted on the strength of its neighbors", () => {
    expect(() =>
      validateTaskSpecAgainstInventory(
        {
          kind: "chain",
          steps: [
            { use: "wfd_summarizer", refinedOutcome: "Summarize" },
            {
              create: {
                name: "Bot",
                systemPrompt: "Prompt.",
                toolPackagePins: [],
                skills: ["unknown-skill"],
              },
              refinedOutcome: "Review",
            },
          ],
        },
        INVENTORY,
      ),
    ).toThrow(PlannerReferenceOutOfInventoryError);
  });
});
