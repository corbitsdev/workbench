import { describe, expect, test } from "bun:test";
import type { Capability } from "@intx/types";
import {
  hasCompletionCapableModel,
  isChatPickerModelName,
  isGgufOrHuggingFacePath,
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

  // CL-6477: "embeddinggemma" has no delimiter between "embedding" and
  // "gemma", unlike every other embedding model name this filter has seen
  // (nomic-embed-text, all-minilm, bge-m3, qwen3-embedding all delimit
  // with "-" or "_"). A regex that required a trailing delimiter after
  // "embed(ding)?" let it through, where it then won the alphabetical
  // default-model tiebreak and answered every chat turn with "does not
  // support chat".
  test("drops an uncataloged embeddinggemma offering even with no delimiter after 'embedding'", () => {
    const offerings = [noData("embeddinggemma:300m"), completion("qwen3:8b")];
    expect(
      preferCompletionCapable(offerings, capabilitiesOf, nameOf).map(
        (o) => o.name,
      ),
    ).toEqual(["qwen3:8b"]);
  });

  test("still filters the delimited embedding-model names (no regression)", () => {
    const offerings = [
      noData("nomic-embed-text"),
      noData("all-minilm"),
      noData("bge-m3"),
      noData("qwen3-embedding"),
      noData("snowflake-arctic-embed"),
      completion("qwen3:8b"),
    ];
    expect(
      preferCompletionCapable(offerings, capabilitiesOf, nameOf).map(
        (o) => o.name,
      ),
    ).toEqual(["qwen3:8b"]);
  });

  test("prefers real capability data over the name fallback: a probed completion offering named like an embedding model is kept", () => {
    const probedCompletion: Offering = {
      name: "embeddinggemma:300m",
      capabilities: ["plain-text"],
    };
    expect(
      preferCompletionCapable(
        [probedCompletion, noData("all-minilm")],
        capabilitiesOf,
        nameOf,
      ).map((o) => o.name),
    ).toEqual(["embeddinggemma:300m"]);
  });

  // CL-6744: Hugging Face Hub / GGUF path names never win a chat default
  // or appear in person-facing pickers, even when capability data says
  // plain-text (Ollama's hf.co pulls often report completion).
  test("CL-6744: drops hf.co and huggingface.co paths even with plain-text capabilities", () => {
    const offerings = [
      completion("hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M"),
      completion(
        "huggingface.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF",
      ),
      completion("qwen3:8b"),
    ];
    expect(
      preferCompletionCapable(offerings, capabilitiesOf, nameOf).map(
        (o) => o.name,
      ),
    ).toEqual(["qwen3:8b"]);
  });

  test("CL-6744: drops bare .gguf path/tag names", () => {
    const offerings = [
      noData("Llama-3.2-3B-Instruct-IQ3_M.gguf"),
      completion("qwen3:8b"),
    ];
    expect(
      preferCompletionCapable(offerings, capabilitiesOf, nameOf).map(
        (o) => o.name,
      ),
    ).toEqual(["qwen3:8b"]);
  });
});

describe("isChatPickerModelName / isGgufOrHuggingFacePath", () => {
  test("CL-6744: name-only gate rejects embeddings, GGUF paths, and HF URIs", () => {
    expect(isChatPickerModelName("qwen3:8b")).toBe(true);
    expect(isChatPickerModelName("anthropic/claude-sonnet-4")).toBe(true);
    expect(isChatPickerModelName("all-minilm")).toBe(false);
    expect(isChatPickerModelName("nomic-embed-text")).toBe(false);
    expect(isChatPickerModelName("qwen3-embedding")).toBe(false);
    expect(isChatPickerModelName("snowflake-arctic-embed")).toBe(false);
    expect(
      isChatPickerModelName("hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M"),
    ).toBe(false);
    expect(isChatPickerModelName("model.Q4_K_M.gguf")).toBe(false);
    expect(isGgufOrHuggingFacePath("hf.co/org/repo")).toBe(true);
    expect(isGgufOrHuggingFacePath("qwen3:8b")).toBe(false);
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

  test("false when the only offering is an uncataloged embeddinggemma pull (CL-6477)", () => {
    expect(
      hasCompletionCapableModel(
        [noData("embeddinggemma:300m")],
        capabilitiesOf,
        nameOf,
      ),
    ).toBe(false);
  });

  test("a chat-capable model is selected as the default when both an embeddinggemma pull and a chat model are present", () => {
    const offerings = [noData("embeddinggemma:300m"), completion("qwen3:8b")];
    const chatDefault = preferCompletionCapable(
      offerings,
      capabilitiesOf,
      nameOf,
    )[0];
    expect(chatDefault?.name).toBe("qwen3:8b");
  });

  test("CL-6744: prefers a local chat model over an alphabetically-earlier hf.co pull on refresh", () => {
    const offerings = [
      completion("hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF"),
      completion("qwen3:8b"),
    ];
    const chatDefault = preferCompletionCapable(
      offerings,
      capabilitiesOf,
      nameOf,
    )[0];
    expect(chatDefault?.name).toBe("qwen3:8b");
  });
});
