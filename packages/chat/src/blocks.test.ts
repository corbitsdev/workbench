import { describe, expect, test } from "bun:test";

import { parseBlock } from "./blocks";

describe("parseBlock", () => {
  test("parses an approve block's reference-and-framing shape", () => {
    const result = parseBlock({
      type: "approve",
      data: {
        approvalId: "apv_fixture1",
        title: "Deploy staging",
        risk: "medium",
        riskNote: "touches shared infra",
        body: "Rolls out the new ingest worker.",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.summary);
    expect(result.block.type).toBe("approve");
    if (result.block.type !== "approve") throw new Error("wrong type");
    expect(result.block.data.approvalId).toBe("apv_fixture1");
    expect(result.block.data.risk).toBe("medium");
  });

  test("rejects an approve block without an approvalId", () => {
    const result = parseBlock({
      type: "approve",
      data: { title: "Deploy staging" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.type).toBe("approve");
    expect(result.summary).toContain("approvalId");
  });

  test("rejects an approve block with a risk outside the enum", () => {
    const result = parseBlock({
      type: "approve",
      data: { approvalId: "apv_x", title: "T", risk: "catastrophic" },
    });
    expect(result.ok).toBe(false);
  });

  test("parses a steps block with every step state", () => {
    const result = parseBlock({
      type: "steps",
      data: {
        title: "Migration",
        steps: [
          { label: "Snapshot", state: "done", note: "2s" },
          { label: "Apply", state: "running" },
          { label: "Verify", state: "queued" },
          { label: "Rollback", state: "error" },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.summary);
    if (result.block.type !== "steps") throw new Error("wrong type");
    expect(result.block.data.steps).toHaveLength(4);
  });

  test("rejects a steps block with an unknown state", () => {
    const result = parseBlock({
      type: "steps",
      data: { title: "M", steps: [{ label: "x", state: "run" }] },
    });
    expect(result.ok).toBe(false);
  });

  test("parses a metrics block with tiles and bars", () => {
    const result = parseBlock({
      type: "metrics",
      data: {
        title: "Ingest health",
        metrics: [
          { label: "P95", value: "412ms", detail: "-8%", trend: "up" },
          { label: "Errors", value: "0.2%" },
        ],
        bars: [
          { label: "us-east", percent: 64 },
          { label: "eu-west", percent: 100 },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.summary);
    if (result.block.type !== "metrics") throw new Error("wrong type");
    expect(result.block.data.bars).toHaveLength(2);
  });

  test("rejects a metric trend outside the enum", () => {
    const result = parseBlock({
      type: "metrics",
      data: {
        title: "T",
        metrics: [{ label: "P95", value: "412ms", trend: "sideways" }],
      },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects a metrics bar percent outside 0-100", () => {
    const result = parseBlock({
      type: "metrics",
      data: {
        title: "T",
        metrics: [],
        bars: [{ label: "x", percent: 120 }],
      },
    });
    expect(result.ok).toBe(false);
  });

  test("parses a poll block without agent-authored tallies", () => {
    const result = parseBlock({
      type: "poll",
      data: {
        pollId: "blk_poll1",
        title: "Ship day?",
        choices: [
          { id: "tue", label: "Tuesday" },
          { id: "thu", label: "Thursday" },
        ],
        multi: false,
        closesAt: "2026-08-20T00:00:00.000Z",
      },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects a poll block with a malformed closesAt", () => {
    const result = parseBlock({
      type: "poll",
      data: {
        pollId: "blk_poll1",
        title: "T",
        choices: [{ id: "a", label: "A" }],
        closesAt: "next tuesday",
      },
    });
    expect(result.ok).toBe(false);
  });

  test("parses a form block with each input kind", () => {
    const result = parseBlock({
      type: "form",
      data: {
        formId: "blk_form1",
        title: "Release notes",
        fields: [
          { id: "name", label: "Name", input: "text", value: "v1.4" },
          { id: "notes", label: "Notes", input: "textarea", required: true },
          {
            id: "workbench",
            label: "Workbench",
            input: "select",
            options: ["stable", "beta"],
            value: "beta",
          },
          { id: "notify", label: "Notify", input: "checkbox", value: "true" },
        ],
        submitLabel: "Save",
      },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects a select field without options and with an empty list", () => {
    for (const field of [
      { id: "x", label: "X", input: "select" },
      { id: "x", label: "X", input: "select", options: [] },
    ]) {
      const result = parseBlock({
        type: "form",
        data: { formId: "blk_form1", title: "T", fields: [field] },
      });
      expect(result.ok).toBe(false);
    }
  });

  test("rejects a form field with an unknown input kind", () => {
    const result = parseBlock({
      type: "form",
      data: {
        formId: "blk_form1",
        title: "T",
        fields: [{ id: "x", label: "X", input: "richtext" }],
      },
    });
    expect(result.ok).toBe(false);
  });

  test("parses stream blocks in-flight and done", () => {
    for (const done of [false, true]) {
      const result = parseBlock({
        type: "stream",
        data: { title: "Build log", text: "compiling…", done },
      });
      expect(result.ok).toBe(true);
    }
  });

  test("returns a typed fallback for an unknown block type", () => {
    const result = parseBlock({ type: "carousel", data: {} });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.type).toBe("carousel");
    expect(result.summary).toContain("carousel");
  });

  test("never throws on garbage data", () => {
    for (const data of [null, 42, "text", [], { nested: { deep: true } }]) {
      expect(parseBlock({ type: "metrics", data }).ok).toBe(false);
    }
  });
});

describe("parseBlock hostile inputs", () => {
  test("prototype-polluting JSON does not pollute and does not throw", () => {
    const data: unknown = JSON.parse(
      '{"approvalId":"a","title":"t","__proto__":{"polluted":true}}',
    );
    const result = parseBlock({ type: "approve", data });
    expect(result.ok).toBe(true);
    const probe: Record<string, unknown> = {};
    expect(probe.polluted).toBeUndefined();
  });

  test("oversized payload parses without throwing", () => {
    const steps = Array.from({ length: 50_000 }, (_, i) => ({
      label: `step ${i}`,
      state: "queued",
    }));
    const result = parseBlock({ type: "steps", data: { title: "t", steps } });
    expect(result.ok).toBe(true);
  });

  test("huge unknown type string returns fallback, not a throw", () => {
    const result = parseBlock({ type: "x".repeat(1_000_000), data: {} });
    expect(result.ok).toBe(false);
  });

  test("undeclared keys are stripped from the parsed data", () => {
    const result = parseBlock({
      type: "poll",
      data: {
        pollId: "p",
        title: "t",
        choices: [{ id: "a", label: "A", weight: 3 }],
        tally: { a: 9999 },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.block.type !== "poll") throw new Error("shape");
    expect(Object.keys(result.block.data).sort()).toEqual([
      "choices",
      "pollId",
      "title",
    ]);
    const choice = result.block.data.choices[0];
    if (choice === undefined) throw new Error("missing choice");
    expect(Object.keys(choice).sort()).toEqual(["id", "label"]);
  });

  test("NaN, Infinity, and out-of-range percents are rejected", () => {
    for (const percent of [Number.NaN, Number.POSITIVE_INFINITY, -1, 100.5]) {
      const result = parseBlock({
        type: "metrics",
        data: { title: "t", metrics: [], bars: [{ label: "x", percent }] },
      });
      expect(result.ok).toBe(false);
    }
  });

  test("non-object data for every known type fails cleanly", () => {
    for (const t of [
      "approve",
      "steps",
      "metrics",
      "poll",
      "form",
      "stream",
      "question",
    ]) {
      for (const data of [null, undefined, 0, "s", [], () => {}]) {
        const result = parseBlock({ type: t, data });
        expect(result.ok).toBe(false);
      }
    }
  });
});

describe("parseBlock — question", () => {
  test("round-trips a question with lettered options and no free text", () => {
    const result = parseBlock({
      type: "question",
      data: {
        questionId: "q_fixture1",
        question: "Which environment should this deploy to?",
        subtitle: "Pick the closest match.",
        options: ["Staging", "Production", "Canary"],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.summary);
    expect(result.block.type).toBe("question");
    if (result.block.type !== "question") throw new Error("wrong type");
    expect(result.block.data.options).toEqual([
      "Staging",
      "Production",
      "Canary",
    ]);
    expect(result.block.data.allowFreeText).toBeUndefined();
  });

  test("round-trips allowFreeText", () => {
    const result = parseBlock({
      type: "question",
      data: {
        questionId: "q_fixture2",
        question: "What should we call the new agent?",
        options: ["Myra", "Otto"],
        allowFreeText: true,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.summary);
    if (result.block.type !== "question") throw new Error("wrong type");
    expect(result.block.data.allowFreeText).toBe(true);
  });

  test("rejects fewer than 2 options", () => {
    const result = parseBlock({
      type: "question",
      data: { questionId: "q1", question: "Q?", options: ["only one"] },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects more than 6 options", () => {
    const result = parseBlock({
      type: "question",
      data: {
        questionId: "q1",
        question: "Q?",
        options: ["a", "b", "c", "d", "e", "f", "g"],
      },
    });
    expect(result.ok).toBe(false);
  });

  test("strips undeclared keys", () => {
    const result = parseBlock({
      type: "question",
      data: {
        questionId: "q1",
        question: "Q?",
        options: ["a", "b"],
        tally: { a: 99 },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.summary);
    if (result.block.type !== "question") throw new Error("wrong type");
    expect(
      (result.block.data as Record<string, unknown>)["tally"],
    ).toBeUndefined();
  });
});
