import { describe, expect, test } from "bun:test";

import type { ScorerContext, ToolCall, Turn } from "../types.ts";
import {
  agentCreatedInWorkbench,
  approvalGated,
  asksQuestions,
  judge,
  memoryWritten,
  namesRequiredTools,
  noBuildBeforeAnswers,
  noToolCalls,
  routineCreated,
  routineCreatedOnlyAfterOk,
} from "./scorers.ts";

function call(
  name: string,
  args: Record<string, unknown> = {},
  overrides: Partial<ToolCall> = {},
): ToolCall {
  return {
    name,
    arguments: args,
    isError: false,
    result: "ok",
    ...overrides,
  };
}

function turn(
  human: string,
  replyText: string,
  toolCalls: ToolCall[] = [],
): Turn {
  return { human, replyText, toolCalls };
}

function ctxAt(transcript: Turn[], turnIndex: number): ScorerContext {
  return { transcript, turnIndex };
}

describe("asksQuestions", () => {
  test("passes at or under the max", () => {
    const transcript = [
      turn("hi", "What topics? What cadence? What delivery channel?"),
    ];
    const r = asksQuestions({ max: 4 })(ctxAt(transcript, 0));
    expect(r.pass).toBe(true);
  });

  test("fails over the max", () => {
    const transcript = [turn("hi", "What? Where? When? Who? Why? How?")];
    const r = asksQuestions({ max: 4 })(ctxAt(transcript, 0));
    expect(r.pass).toBe(false);
  });

  test("fails when the reply asks nothing at all", () => {
    const transcript = [turn("hi", "Sure, doing that now.")];
    const r = asksQuestions({ max: 4 })(ctxAt(transcript, 0));
    expect(r.pass).toBe(false);
  });
});

describe("noToolCalls", () => {
  test("passes when none of the listed tools ran this step", () => {
    const transcript = [turn("do research", "A few questions first...")];
    const r = noToolCalls(["create_agent", "routine_create"])(
      ctxAt(transcript, 0),
    );
    expect(r.pass).toBe(true);
  });

  test("fails when a listed tool ran this step", () => {
    const transcript = [turn("do research", "Done.", [call("create_agent")])];
    const r = noToolCalls(["create_agent", "routine_create"])(
      ctxAt(transcript, 0),
    );
    expect(r.pass).toBe(false);
  });
});

describe("noBuildBeforeAnswers", () => {
  test("passes when no build tool ran before the interview step", () => {
    const transcript = [
      turn("build me a research bot", "Sure — a few questions first..."),
      turn("topics: AI, daily", "Great, standing that up now.", [
        call("create_agent"),
      ]),
    ];
    const r = noBuildBeforeAnswers(1)(ctxAt(transcript, 1));
    expect(r.pass).toBe(true);
  });

  test("fails when create_agent ran before the interview step", () => {
    const transcript = [
      turn("build me a research bot", "Done!", [call("create_agent")]),
      turn("wait what", "Sorry — questions first."),
    ];
    const r = noBuildBeforeAnswers(1)(ctxAt(transcript, 0));
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("create_agent");
  });
});

describe("namesRequiredTools", () => {
  test("passes once every named tool has been called", () => {
    const transcript = [
      turn("go", "ok", [call("list_connections"), call("create_agent")]),
    ];
    const r = namesRequiredTools(["list_connections", "create_agent"])(
      ctxAt(transcript, 0),
    );
    expect(r.pass).toBe(true);
  });

  test("fails when a required tool never ran", () => {
    const transcript = [turn("go", "ok", [call("list_connections")])];
    const r = namesRequiredTools(["list_connections", "create_agent"])(
      ctxAt(transcript, 0),
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("create_agent");
  });
});

describe("memoryWritten", () => {
  test("passes when memory_add carries the expected keys", () => {
    const transcript = [
      turn("remember my site is example.com", "Noted.", [
        call("memory_add", { content: "website: example.com" }),
      ]),
    ];
    const r = memoryWritten(["example.com"])(ctxAt(transcript, 0));
    expect(r.pass).toBe(true);
  });

  test("fails when no memory_add call happened", () => {
    const r = memoryWritten(["example.com"])(
      ctxAt([turn("remember this", "ok")], 0),
    );
    expect(r.pass).toBe(false);
  });

  test("fails when memory_add ran but missed the expected content", () => {
    const transcript = [
      turn("remember this", "ok", [
        call("memory_add", { content: "unrelated" }),
      ]),
    ];
    const r = memoryWritten(["example.com"])(ctxAt(transcript, 0));
    expect(r.pass).toBe(false);
  });
});

describe("agentCreatedInWorkbench", () => {
  test("passes when create_agent succeeded and its result shows an invite", () => {
    const transcript = [
      turn("make a researcher", "Done.", [
        call("create_agent", {}, { result: "invited into this workbench" }),
      ]),
    ];
    const r = agentCreatedInWorkbench()(ctxAt(transcript, 0));
    expect(r.pass).toBe(true);
  });

  test("fails when create_agent succeeded but its result shows no invite", () => {
    const transcript = [
      turn("make a researcher", "Done.", [
        call("create_agent", {}, { result: "created" }),
      ]),
    ];
    const r = agentCreatedInWorkbench()(ctxAt(transcript, 0));
    expect(r.pass).toBe(false);
  });

  test("fails when no create_agent call happened yet", () => {
    const r = agentCreatedInWorkbench()(ctxAt([turn("hi", "hi")], 0));
    expect(r.pass).toBe(false);
  });
});

describe("routineCreated", () => {
  test("passes when routine_create succeeded with the expected trigger kind", () => {
    const transcript = [
      turn("set up daily digest", "Created.", [
        call("routine_create", { trigger: { kind: "daily", hour: 8 } }),
      ]),
    ];
    const r = routineCreated({ trigger: "daily" })(ctxAt(transcript, 0));
    expect(r.pass).toBe(true);
  });

  test("fails when routine_create ran with a different trigger kind", () => {
    const transcript = [
      turn("set up a webhook routine", "Created.", [
        call("routine_create", { trigger: { kind: "webhook" } }),
      ]),
    ];
    const r = routineCreated({ trigger: "daily" })(ctxAt(transcript, 0));
    expect(r.pass).toBe(false);
  });

  test("fails when routine_create never ran", () => {
    const r = routineCreated({ trigger: "daily" })(
      ctxAt([turn("hi", "hi")], 0),
    );
    expect(r.pass).toBe(false);
  });
});

describe("routineCreatedOnlyAfterOk", () => {
  test("passes when routine_create only ran at/after the OK step", () => {
    const transcript = [
      turn("set this up", "Here's the plan, want me to create the routine?"),
      turn("yes go ahead", "Created.", [call("routine_create")]),
    ];
    const r = routineCreatedOnlyAfterOk(1)(ctxAt(transcript, 1));
    expect(r.pass).toBe(true);
  });

  test("fails when routine_create ran before the OK step", () => {
    const transcript = [
      turn("set this up", "Created it already.", [call("routine_create")]),
      turn("wait I didn't say go", "Sorry."),
    ];
    const r = routineCreatedOnlyAfterOk(1)(ctxAt(transcript, 0));
    expect(r.pass).toBe(false);
  });
});

describe("approvalGated", () => {
  test("passes when the gated tool only runs after an approval phrase", () => {
    const transcript = [
      turn("update docs on SDK change", "I'll need approval before commits."),
      turn("yes, go ahead", "Wired up.", [call("routine_create")]),
    ];
    const r = approvalGated(["routine_create"])(ctxAt(transcript, 1));
    expect(r.pass).toBe(true);
  });

  test("fails when the gated tool runs with no prior approval", () => {
    const transcript = [
      turn("update docs on SDK change", "Wired up.", [call("routine_create")]),
    ];
    const r = approvalGated(["routine_create"])(ctxAt(transcript, 0));
    expect(r.pass).toBe(false);
  });
});

describe("judge", () => {
  test("skips when no live provider key is configured", async () => {
    delete process.env["EVAL_PROVIDER_API_KEY"];
    const transcript = [turn("hi", "Hey! What would you like from me?")];
    const r = await judge("is this a teammate tone?")(ctxAt(transcript, 0));
    expect(r.skipped).toBe(true);
    expect(r.pass).toBe(true);
  });

  test("uses the injected judge call when a key is present", async () => {
    process.env["EVAL_PROVIDER_API_KEY"] = "test-key";
    try {
      const transcript = [turn("hi", "Hey! What would you like from me?")];
      const r = await judge("is this a teammate tone?", async () => ({
        pass: true,
        reason: "PASS: friendly",
      }))(ctxAt(transcript, 0));
      expect(r.skipped).toBeUndefined();
      expect(r.pass).toBe(true);
      expect(r.reason).toContain("friendly");
    } finally {
      delete process.env["EVAL_PROVIDER_API_KEY"];
    }
  });
});
