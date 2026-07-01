import { describe, expect, it } from "bun:test";
import { attachmentCapabilityForAgent } from "./attachment-capabilities";

describe("attachmentCapabilityForAgent", () => {
  it("gives Myra (kimi via openai-compatible) images-only", () => {
    expect(attachmentCapabilityForAgent("Myra")).toBe("images-only");
  });

  it("gives the Anthropic agents images+pdf", () => {
    expect(attachmentCapabilityForAgent("Freddie")).toBe("images+pdf");
    expect(attachmentCapabilityForAgent("Fannie")).toBe("images+pdf");
  });

  it("disables attachments for a deepseek text-only agent", () => {
    expect(attachmentCapabilityForAgent("Oat")).toBe("none");
    expect(attachmentCapabilityForAgent("Walter")).toBe("none");
  });

  it("fails closed to none for an unknown agent name", () => {
    expect(attachmentCapabilityForAgent("Nonexistent")).toBe("none");
  });
});
