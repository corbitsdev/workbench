// Tests for the summarize-older-turns compactor (CL-6204): a director that
// registers this name and fires `caps.compact("summarize-older-turns", ...)`
// gets a bounded, deterministic fold of everything older than the newest
// `keep` turns instead of silent context-window truncation.
import { expect, test } from "bun:test";

import type { ConversationTurn, StrategyContext } from "@intx/types/runtime";

import {
  SUMMARIZE_OLDER_TURNS_NAME,
  createSummarizeOlderTurnsCompactor,
} from "./compactors";

function textTurn(
  role: ConversationTurn["role"],
  text: string,
  timestamp: number,
): ConversationTurn {
  return { role, content: [{ type: "text", text }], timestamp };
}

function makeCtx(): StrategyContext {
  return {
    state: {
      turns: [],
      lastCheckpointHash: undefined,
    } as unknown as StrategyContext["state"],
    trigger: "director:test",
  };
}

test("passes turns through unfolded when at or under the keep count", async () => {
  const compactor = createSummarizeOlderTurnsCompactor({ keep: 12 });
  const turns = Array.from({ length: 12 }, (_, i) =>
    textTurn(i % 2 === 0 ? "user" : "assistant", `turn ${i}`, i),
  );

  const result = await compactor.apply(turns, makeCtx());

  expect(result.output).toEqual(turns);
  expect(result.record.reason).toBe("within-keep-window");
});

test("keeps the newest K turns verbatim and folds the rest into one synthetic summary turn", async () => {
  const compactor = createSummarizeOlderTurnsCompactor({ keep: 12 });
  const turns = Array.from({ length: 20 }, (_, i) =>
    textTurn(i % 2 === 0 ? "user" : "assistant", `turn ${i}`, i),
  );

  const result = await compactor.apply(turns, makeCtx());

  // 1 synthetic summary turn + the newest 12 verbatim turns.
  expect(result.output).toHaveLength(13);
  const [summary, ...kept] = result.output;
  expect(summary).toBeDefined();
  expect(summary?.role).toBe("system");
  expect(kept).toEqual(turns.slice(turns.length - 12));
  expect(result.record.reason).toBe("folded-older-turns");
  expect(result.record.decisions["foldedCount"]).toBe(8);
  expect(result.record.strategy).toBe(SUMMARIZE_OLDER_TURNS_NAME);
});

test("the fold is deterministic for the same input", async () => {
  const compactor = createSummarizeOlderTurnsCompactor({ keep: 4 });
  const turns = Array.from({ length: 10 }, (_, i) =>
    textTurn(i % 2 === 0 ? "user" : "assistant", `message number ${i}`, i),
  );

  const first = await compactor.apply(turns, makeCtx());
  const second = await compactor.apply(turns, makeCtx());

  expect(first.output).toEqual(second.output);
});

test("caps each folded turn's contribution so the summary stays bounded regardless of turn count or length", async () => {
  const compactor = createSummarizeOlderTurnsCompactor({
    keep: 2,
    maxSummaryChars: 500,
  });
  const turns = Array.from({ length: 200 }, (_, i) =>
    textTurn(
      "user",
      `a very long message repeated many times `.repeat(20) + String(i),
      i,
    ),
  );

  const result = await compactor.apply(turns, makeCtx());
  const summary = result.output[0];

  expect(summary?.content[0]?.type).toBe("text");
  const text =
    summary?.content[0]?.type === "text" ? summary.content[0].text : "";
  expect(text.length).toBeLessThanOrEqual(500);
});

test("non-text content blocks fold to a short placeholder rather than being dropped silently", async () => {
  const compactor = createSummarizeOlderTurnsCompactor({ keep: 1 });
  const turns: ConversationTurn[] = [
    {
      role: "assistant",
      timestamp: 1,
      content: [{ type: "tool_call", id: "c1", name: "search", arguments: {} }],
    },
    textTurn("user", "second", 2),
    textTurn("assistant", "third", 3),
  ];

  const result = await compactor.apply(turns, makeCtx());
  const summary = result.output[0];
  const text =
    summary?.content[0]?.type === "text" ? summary.content[0].text : "";
  expect(text).toContain("tool_call");
});

test("carries the compactor's name and a version for the manifest record", () => {
  const compactor = createSummarizeOlderTurnsCompactor({ keep: 12 });
  expect(compactor.name).toBe(SUMMARIZE_OLDER_TURNS_NAME);
  expect(compactor.version).toBe("1");
});
