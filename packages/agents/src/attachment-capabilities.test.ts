import { describe, expect, it } from "bun:test";
import {
  attachmentCapabilityForAgent,
  attachmentPolicyForAgent,
} from "./attachment-capabilities";

describe("attachmentCapabilityForAgent", () => {
  it("gives Myra (kimi via openai-compatible) NO native capability", () => {
    // kimi-k2.6's endpoint 400s on inline image_url parts, so Myra is not
    // natively vision-capable — images divert through the File Parser instead.
    expect(attachmentCapabilityForAgent("Myra")).toBe("none");
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
  it("keeps Myra's NATIVE capability none (inline-mail guard stays strict)", () => {
    // The hub inline-mail guard derives from this; neither a document nor an
    // image may ride inline to Myra's openai-compatible adapter.
    expect(attachmentCapabilityForAgent("Myra")).toBe("none");
  });

  it("relaxes Myra's COMPOSER policy to accept images AND pdf via the parser", () => {
    const policy = attachmentPolicyForAgent("Myra");
    expect(policy).toBeDefined();
    // Both are offered through the File Parser divert path, not native inline.
    expect(policy!.acceptedMimeTypes).toContain("application/pdf");
    expect(policy!.acceptedMimeTypes).toContain("image/png");
    expect(policy!.acceptedMimeTypes).toContain("image/jpeg");
  });

  it("does not offer parser files to an agent without the parse_file tool", () => {
    // Oat is deepseek (native none) with no parse_file capability, so it gains
    // nothing from the parser path and takes no attachments at all.
    const oat = attachmentPolicyForAgent("Oat");
    expect(oat).toBeUndefined();
  });

  it("keeps native inline images (not parser images) for a vision-capable parse agent", () => {
    // A natively vision-capable agent already carries images in its native set;
    // the parser path must not additionally offer them (inline > OCR fidelity).
    // Freddie is anthropic (images+pdf native); its policy is unchanged.
    const freddie = attachmentPolicyForAgent("Freddie");
    expect(freddie).toBeDefined();
    expect(freddie!.acceptedMimeTypes).toContain("image/png");
    expect(freddie!.acceptedMimeTypes).toContain("application/pdf");
  });
});
