import { type, type Type } from "arktype";

interface CodexQuirksShape {
  productName: string;
  environmentTagName: string;
}

/**
 * Host identity a Codex bridge message needs and cannot default. An absent
 * bag is a validation error — there is no honest generic product name.
 */
export const CodexQuirks: Type<CodexQuirksShape> = type({
  productName: "string",
  environmentTagName: "string",
  "+": "reject",
});
export type CodexQuirks = CodexQuirksShape;

/** Thrown when a `CodexQuirks` bag fails validation (missing host identity, unknown key). */
export class CodexQuirksError extends Error {
  override readonly name = "CodexQuirksError";
}

/** Parses an adapter's `quirks` argument into a validated {@link CodexQuirks}. An absent bag is a validation error: there is no honest default product name. */
export function parseCodexQuirks(raw: unknown): CodexQuirks {
  const validated = CodexQuirks(raw ?? {});
  if (validated instanceof type.errors) {
    throw new CodexQuirksError(
      `@corbits/codex-provider: invalid quirks: ${validated.summary}`,
    );
  }
  return validated;
}
