import { describe, expect, it } from "bun:test";
import {
  attachmentCapabilityForAgent,
  attachmentPolicyForAgent,
} from "./attachment-capabilities";

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

describe("attachmentPolicyForAgent — File Parser (CL-2628) relaxation", () => {
  it("keeps Myra's NATIVE capability images-only (inline-mail guard stays strict)", () => {
    // The hub inline-mail guard derives from this; a document must never ride
    // inline to Myra's openai-compatible adapter, so this stays images-only.
    expect(attachmentCapabilityForAgent("Myra")).toBe("images-only");
  });

  it("relaxes Myra's COMPOSER policy to also accept application/pdf via the parser", () => {
    const policy = attachmentPolicyForAgent("Myra");
    expect(policy).toBeDefined();
    expect(policy!.acceptedMimeTypes).toContain("application/pdf");
    // still accepts images natively
    expect(policy!.acceptedMimeTypes).toContain("image/png");
  });

  it("does not add parser documents to an agent without the parse_file tool", () => {
    // Freddie is anthropic (natively images+pdf), but a text-only agent with no
    // parse_file capability must not gain documents from the parser path.
    const oat = attachmentPolicyForAgent("Oat");
    expect(oat).toBeUndefined();
  });
});
