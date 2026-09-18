// Every OpenAI-compatible provider (OpenAI, xAI, Groq, DeepSeek, Mistral,
// OpenRouter, Ollama, ...) caps a function name at 64 chars on the wire,
// and the wire form of a qualified tool name (`<bundle id>:<tool>`) grows
// under encoding. A bundle whose longest tool blows the cap fails the
// agent's first turn on every such provider — so every corbits tool
// package's names are checked here against the strictest limit.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { encodeToolName } from "@intx/inference";

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

const TOOLS_ROOT = path.resolve(import.meta.dir, "../../../../tools");

async function toolPackageDirs(): Promise<string[]> {
  const entries = await readdir(TOOLS_ROOT, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(path.join(TOOLS_ROOT, entry.name, "package.json")),
    )
    .map((entry) => entry.name);
}

describe("corbits tool packages fit the 64-char OpenAI-compatible tool-name cap", () => {
  test("every tools/* package's qualified tool names encode within the cap", async () => {
    const dirs = await toolPackageDirs();
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      const mod = (await import(path.join(TOOLS_ROOT, dir, "src", "index.ts"))) as Record<
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
    }
  });
});
