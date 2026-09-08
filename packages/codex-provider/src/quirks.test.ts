import { describe, expect, test } from "bun:test";
import { parseCodexQuirks } from "./index";

// `CodexQuirks` is annotated `Type<CodexQuirksShape>` (see quirks.ts for
// why), which hides the schema's `"+": "reject"` at the type level — only a
// runtime check catches a regression that drops that annotation.
describe("Codex quirks — unknown key rejection", () => {
  test("rejects a quirks bag carrying a key outside the schema", () => {
    expect(() =>
      parseCodexQuirks({
        productName: "Acme",
        environmentTagName: "acme_env",
        bogus: 1,
      }),
    ).toThrow();
  });
});
