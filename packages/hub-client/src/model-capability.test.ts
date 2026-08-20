import { describe, expect, test } from "bun:test";
import type { Capability } from "@intx/types";
import {
  hasCompletionCapableModel,
  preferCompletionCapable,
} from "./model-capability";

type Offering = { name: string; capabilities: readonly Capability[] };

const completion = (name: string): Offering => ({
  name,
  capabilities: ["plain-text"],
});
/** No wire-probe data — the pinned catalog has never seen this deployment
 * (a local Ollama pull, in particular). Indistinguishable from a probed
 * embedding deployment at the capability layer alone; the name is the
 * only remaining signal. */
const noData = (name: string): Offering => ({ name, capabilities: [] });

const capabilitiesOf = (o: Offering) => o.capabilities;
const nameOf = (o: Offering) => o.name;

describe("preferCompletionCapable", () => {
  test("drops an uncataloged offering whose name looks like an embedding model, sorting first, when a completion offering exists", () => {
    const offerings = [noData("all-minilm"), completion("qwen3:8b")];
    expect(
      preferCompletionCapable(offerings, capabilitiesOf, nameOf).map(
        (o) => o.name,
      ),
    ).toEqual(["qwen3:8b"]);
  });

  test("keeps every offering when all are completion-capable", () => {
    const offerings = [completion("gpt-4o"), completion("claude-sonnet-4-5")];
    expect(preferCompletionCapable(offerings, capabilitiesOf, nameOf)).toEqual(
      offerings,
    );
  });

  test("keeps an uncataloged offering whose name doesn't look like an embedding model", () => {
    const offerings = [noData("qwen3:8b"), noData("llama3.1:70b")];
    expect(preferCompletionCapable(offerings, capabilitiesOf, nameOf)).toEqual(
      offerings,
    );
  });

  test("excludes every offering, never falling back, when all are uncataloged embedding-named models", () => {
    const offerings = [noData("all-minilm"), noData("nomic-embed-text")];
    expect(preferCompletionCapable(offerings, capabilitiesOf, nameOf)).toEqual(
      [],
    );
  });
});

describe("hasCompletionCapableModel", () => {
  test("true when at least one offering is completion-capable", () => {
    expect(
      hasCompletionCapableModel(
        [noData("all-minilm"), completion("qwen3:8b")],
        capabilitiesOf,
        nameOf,
      ),
    ).toBe(true);
  });

  test("false when every offering is an uncataloged embedding-named model", () => {
    expect(
      hasCompletionCapableModel(
        [noData("all-minilm"), noData("nomic-embed-text")],
        capabilitiesOf,
        nameOf,
      ),
    ).toBe(false);
  });
});
