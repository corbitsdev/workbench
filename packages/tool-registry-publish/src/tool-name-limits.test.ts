// Every OpenAI-compatible provider (OpenAI, xAI, Groq, DeepSeek, Mistral,
// OpenRouter, Ollama, ...) caps a function name at 64 chars on the wire,
// and the wire form of a qualified tool name (`<bundle id>:<tool>`) grows
// under encoding. A bundle whose longest tool blows the cap fails the
// agent's first turn on every such provider — so every corbits tool
// package's names are checked here against the strictest limit.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { encodeToolName } from "@intx/inference";
import { CORBITS_TOOL_PACKAGE_DIRS } from "./registry";

const OPENAI_LIMIT = { provider: "openai", maxLength: 64 } as const;

type Bundle = {
  readonly id: string;
  readonly definitions: readonly { readonly name: string }[];
};

function isBundle(value: unknown): value is Bundle {
  return (
    typeof value === "function" &&
    typeof (value as { id?: unknown }).id === "string" &&
    Array.isArray((value as { definitions?: unknown }).definitions)
  );
}

describe("corbits tool packages fit the 64-char OpenAI-compatible tool-name cap", () => {
  for (const dir of CORBITS_TOOL_PACKAGE_DIRS) {
    test(path.basename(dir), async () => {
      const mod = (await import(path.join(dir, "src", "index.ts"))) as Record<
        string,
        unknown
      >;
      const bundles = Object.values(mod).filter(isBundle);
      expect(bundles.length).toBeGreaterThan(0);
      for (const bundle of bundles) {
        for (const definition of bundle.definitions) {
          const qualified = `${bundle.id}:${definition.name}`;
          expect(() => encodeToolName(qualified, OPENAI_LIMIT)).not.toThrow();
        }
      }
    });
  }
});
