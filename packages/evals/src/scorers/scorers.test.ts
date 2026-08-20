import { describe, expect, test } from "bun:test";

import type { ScorerContext, ToolCall, Turn, WorldSnapshot } from "../types.ts";
import {
  agentCreatedInWorkbench,
  agentDefinitionsHaveToolGrants,
  approvalGated,
  asksQuestions,
  githubConnectedViaConnectionsLayer,
  judge,
  memoryWritten,
  namesRequiredTools,
  noBuildBeforeAnswers,
  noToolCalls,
  outwardGitHubActionsRespectGrantBoundary,
  reviewCommentsAttributable,
  routineCreated,
  routineCreatedOnlyAfterOk,
  suggestedFixesStructurallyValid,
  triggerIsWebhookPerPr,
  wholeRunInspectable,
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

const EMPTY_WORLD: WorldSnapshot = {
  capturedAt: "2026-01-01T00:00:00.000Z",
  agentDefinitions: [],
  routines: [],
  connections: [],
  fakeReceipts: [],
};

function ctxAt(transcript: Turn[], turnIndex: number): ScorerContext {
  return { transcript, turnIndex, world: EMPTY_WORLD };
}

function ctxWithSnapshot(
  transcript: Turn[],
  turnIndex: number,
  world: Partial<WorldSnapshot>,
): ScorerContext {
  return { transcript, turnIndex, world: { ...EMPTY_WORLD, ...world } };
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

describe("githubConnectedViaConnectionsLayer", () => {
  test("fails when the world snapshot has no github connection", () => {
    const r = githubConnectedViaConnectionsLayer()(
      ctxAt([turn("connect github", "ok")], 0),
    );
    expect(r.pass).toBe(false);
    expect(r.skipped).toBeUndefined();
  });

  test("passes when the snapshot shows github connected", () => {
    const r = githubConnectedViaConnectionsLayer()(
      ctxWithSnapshot([turn("connect github", "ok")], 0, {
        connections: [
          {
            slug: "github",
            name: "GitHub",
            url: "https://github.com",
            live: true,
          },
        ],
      }),
    );
    expect(r.pass).toBe(true);
  });

  test("fails when the snapshot exists but github isn't live", () => {
    const r = githubConnectedViaConnectionsLayer()(
      ctxWithSnapshot([turn("connect github", "ok")], 0, {
        connections: [
          {
            slug: "github",
            name: "GitHub",
            url: "https://github.com",
            live: false,
          },
        ],
      }),
    );
    expect(r.pass).toBe(false);
    expect(r.skipped).toBeUndefined();
  });
});

describe("agentDefinitionsHaveToolGrants", () => {
  test("fails when the world snapshot has no agent definitions", () => {
    const r = agentDefinitionsHaveToolGrants(["greybeard"])(
      ctxAt([turn("go", "ok")], 0),
    );
    expect(r.pass).toBe(false);
  });

  test("fails when a named handle has no github-shaped tool pin", () => {
    const r = agentDefinitionsHaveToolGrants(["greybeard"])(
      ctxWithSnapshot([turn("go", "ok")], 0, {
        agentDefinitions: [
          {
            id: "1",
            name: "greybeard",
            toolPackagePins: ["memory-tools"],
            skills: [],
            model: null,
          },
        ],
      }),
    );
    expect(r.pass).toBe(false);
  });

  test("passes once every named handle has a github-shaped tool pin", () => {
    const r = agentDefinitionsHaveToolGrants(["greybeard"])(
      ctxWithSnapshot([turn("go", "ok")], 0, {
        agentDefinitions: [
          {
            id: "1",
            name: "greybeard",
            toolPackagePins: ["github-tools"],
            skills: [],
            model: null,
          },
        ],
      }),
    );
    expect(r.pass).toBe(true);
  });
});

describe("triggerIsWebhookPerPr", () => {
  test("fails when the world snapshot has no routines", () => {
    const r = triggerIsWebhookPerPr()(ctxAt([turn("wire it up", "ok")], 0));
    expect(r.pass).toBe(false);
  });

  test("fails when no routine is enabled with a resolved trigger", () => {
    const r = triggerIsWebhookPerPr()(
      ctxWithSnapshot([turn("wire it up", "ok")], 0, {
        routines: [
          {
            id: "r1",
            name: "daily digest",
            definitionId: "d1",
            trigger: null,
            deliveryWorkbenchId: null,
            enabled: true,
          },
        ],
      }),
    );
    expect(r.pass).toBe(false);
  });

  test("passes when a routine is enabled with a resolved trigger", () => {
    const r = triggerIsWebhookPerPr()(
      ctxWithSnapshot([turn("wire it up", "ok")], 0, {
        routines: [
          {
            id: "r1",
            name: "pr review",
            definitionId: "d1",
            trigger: { kind: "webhook" },
            deliveryWorkbenchId: null,
            enabled: true,
          },
        ],
      }),
    );
    expect(r.pass).toBe(true);
  });
});

describe("reviewCommentsAttributable", () => {
  test("skips — WorldSnapshot has no reviewComments field", () => {
    const r = reviewCommentsAttributable(["greybeard"])(
      ctxAt([turn("pr fired", "ok")], 0),
    );
    expect(r.skipped).toBe(true);
    expect(r.reason).toContain("reviewComments");
  });
});

describe("suggestedFixesStructurallyValid", () => {
  test("fails (documented-red) when the posting tool never ran", () => {
    const r = suggestedFixesStructurallyValid()(
      ctxAt([turn("pr fired", "ok")], 0),
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("CL-6340");
  });

  test("fails when a posted comment carries no suggestedFix", () => {
    const transcript = [
      turn("pr fired", "ok", [
        call("github_post_review_comment", { body: "looks off" }),
      ]),
    ];
    const r = suggestedFixesStructurallyValid()(ctxAt(transcript, 0));
    expect(r.pass).toBe(false);
  });

  test("passes when every posted comment carries a suggestedFix", () => {
    const transcript = [
      turn("pr fired", "ok", [
        call("github_post_review_comment", {
          body: "looks off",
          suggestedFix: "use const instead of let",
        }),
      ]),
    ];
    const r = suggestedFixesStructurallyValid()(ctxAt(transcript, 0));
    expect(r.pass).toBe(true);
  });
});

describe("outwardGitHubActionsRespectGrantBoundary", () => {
  const scorer = () =>
    outwardGitHubActionsRespectGrantBoundary(
      "abklabs/workbench",
      "github_merge_pull_request",
    );

  test("fails (documented-red) when the posting tool never ran", () => {
    const r = scorer()(ctxAt([turn("pr fired", "ok")], 0));
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("CL-6340");
  });

  test("passes with no approval phrase at all, scoped and attributed, no early merge", () => {
    const transcript = [
      turn("pr fired", "ok", [
        call("github_post_review_comment", {
          repo: "abklabs/workbench",
          authorAgentHandle: "greybeard",
          body: "looks good",
        }),
      ]),
    ];
    const r = scorer()(ctxAt(transcript, 0));
    expect(r.pass).toBe(true);
  });

  test("fails when a post is missing audit attribution", () => {
    const transcript = [
      turn("pr fired", "ok", [
        call("github_post_review_comment", {
          repo: "abklabs/workbench",
          body: "looks good",
        }),
      ]),
    ];
    const r = scorer()(ctxAt(transcript, 0));
    expect(r.pass).toBe(false);
  });

  test("fails when the merge tool ran with no prior approval phrase", () => {
    const transcript = [
      turn("pr fired", "ok", [
        call("github_post_review_comment", {
          repo: "abklabs/workbench",
          authorAgentHandle: "greybeard",
          body: "looks good",
        }),
        call("github_merge_pull_request"),
      ]),
    ];
    const r = scorer()(ctxAt(transcript, 0));
    expect(r.pass).toBe(false);
  });

  test("passes when the merge tool only ran after an approval phrase", () => {
    const transcript = [
      turn("pr fired", "ok", [
        call("github_post_review_comment", {
          repo: "abklabs/workbench",
          authorAgentHandle: "greybeard",
          body: "looks good",
        }),
      ]),
      turn("yes go ahead and merge it", "merged.", [
        call("github_merge_pull_request"),
      ]),
    ];
    const r = scorer()(ctxAt(transcript, 1));
    expect(r.pass).toBe(true);
  });
});

describe("wholeRunInspectable", () => {
  test("skips — WorldSnapshot has no runs field", () => {
    const r = wholeRunInspectable()(ctxAt([turn("pr fired", "ok")], 0));
    expect(r.skipped).toBe(true);
    expect(r.reason).toContain("runs");
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
