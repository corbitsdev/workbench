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

  test('a reply with kind: "chain" fails closed — only "task" is accepted today', () => {
    expect(() =>
      parseTaskSpec(
        JSON.stringify({
          kind: "chain",
          use: "wfd_summarizer",
          refinedOutcome: "Summarize the doc",
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
});
