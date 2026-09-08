import { describe, expect, test } from "bun:test";
import { wrapCodexBridgeMessage } from "./index";

// The Codex backend addresses this text as a leading developer message and
// the host's harness relies on the exact tag structure to identify its own
// injected block; a drift here (wrong tag name, dropped priority attribute,
// unclosed tag) is silently accepted by the wire format but breaks whatever
// the host does with that structure downstream.
describe("Codex instructions — bridge message wrap", () => {
  test("produces the exact tag structure with the injected product name and tag", () => {
    const wrapped = wrapCodexBridgeMessage("be helpful", {
      productName: "Acme Code",
      environmentTagName: "acme_environment",
    });

    expect(wrapped).toBe(
      `<acme_environment priority="0">
Acme Code is the harness, not the Codex CLI. The Codex tools named above (apply_patch, update_plan, shell) proxy onto Acme Code's native tools with the same permissions — prefer whichever name appears in the current tool list. These operating instructions are authoritative where they differ from the base instructions:

be helpful
</acme_environment>`,
    );
  });
});
