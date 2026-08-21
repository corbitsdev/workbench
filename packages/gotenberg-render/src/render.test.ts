import { describe, expect, test } from "bun:test";
import { renderMarkdownArtifactToPdf, type PdfArtifactSink } from "./render";

const CONFIG = { baseUrl: "http://gotenberg.internal:3000" };
const SOURCE = {
  title: "Acme Diligence Brief",
  markdown: "# Acme\n\nFindings.",
};

describe("renderMarkdownArtifactToPdf", () => {
  test("renders a markdown artifact and hands the PDF bytes to the sink", async () => {
    const fetchStub = (async () =>
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        status: 200,
      })) as unknown as typeof fetch;
    let savedBytes: Uint8Array | undefined;
    const sink: PdfArtifactSink = {
      async savePdf(input) {
        savedBytes = input.bytes;
        return { id: "artifact-1", version: 1 };
      },
    };

    const result = await renderMarkdownArtifactToPdf(
      CONFIG,
      SOURCE,
      sink,
      { operation: "gotenberg.render" },
      fetchStub,
    );

    expect(result).toEqual({
      ok: true,
      artifact: { id: "artifact-1", version: 1 },
    });
    expect(savedBytes).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  });

  test("surfaces a friendly message and a refId when Gotenberg fails", async () => {
    const fetchStub = (async () =>
      new Response("boom", { status: 503 })) as unknown as typeof fetch;
    const sink: PdfArtifactSink = {
      savePdf: async () => {
        throw new Error("should not be called");
      },
    };

    const result = await renderMarkdownArtifactToPdf(
      CONFIG,
      SOURCE,
      sink,
      { operation: "gotenberg.render", tenantId: "tenant-1" },
      fetchStub,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toBe("Couldn't build the PDF. Try again shortly.");
    expect(result.message).not.toMatch(/503|http|internal/i);
    expect(result.refId.length).toBeGreaterThan(0);
  });
});
