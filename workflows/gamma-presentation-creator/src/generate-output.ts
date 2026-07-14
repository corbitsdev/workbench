import { type } from "arktype";

// Inline-inference generate step output: slide draft lives on `reply`
// (the render step's argMap reads `{ from: "reply" }`).
export const GenerateOutput = type({ reply: "string" });

/** Trimmed draft text from the `generate` step, or undefined when missing/empty. */
export function readGenerateReply(
  stepOutputs: Record<string, unknown>,
): string | undefined {
  const parsed = GenerateOutput(stepOutputs["generate"]);
  if (parsed instanceof type.errors) return undefined;
  const reply = parsed.reply.trim();
  return reply.length > 0 ? reply : undefined;
}
