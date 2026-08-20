import { describe, expect, test } from "bun:test";
import type { Capability } from "@intx/types";
import { preferCompletionCapable } from "./model-capability";

type Offering = { name: string; capabilities: readonly Capability[] };

const completion = (name: string): Offering => ({
  name,
  capabilities: ["plain-text"],
});
const embedding = (name: string): Offering => ({ name, capabilities: [] });
const noData = (name: string): Offering => ({ name, capabilities: [] });

describe("preferCompletionCapable", () => {
  test("drops an embedding-capability offering sorting first when a completion offering exists", () => {
    const offerings = [embedding("all-minilm"), completion("qwen3:8b")];
    expect(
      preferCompletionCapable(offerings, (o) => o.capabilities).map(
        (o) => o.name,
      ),
    ).toEqual(["qwen3:8b"]);
  });

  test("keeps every offering when all are completion-capable", () => {
    const offerings = [completion("gpt-4o"), completion("claude-sonnet-4-5")];
    expect(preferCompletionCapable(offerings, (o) => o.capabilities)).toEqual(
      offerings,
    );
  });

  test("falls back to the unfiltered list when no offering carries capability data", () => {
    const offerings = [noData("all-minilm"), noData("nomic-embed-text")];
    expect(preferCompletionCapable(offerings, (o) => o.capabilities)).toEqual(
      offerings,
    );
  });

  test("falls back to the unfiltered list when data exists but none is completion-capable", () => {
    const offerings = [embedding("all-minilm"), embedding("nomic-embed-text")];
    expect(preferCompletionCapable(offerings, (o) => o.capabilities)).toEqual(
      offerings,
    );
  });
});
