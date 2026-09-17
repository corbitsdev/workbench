import { describe, expect, test } from "bun:test";
import { GotenbergRenderError, renderMarkdownToPdf } from "./client";

describe("renderMarkdownToPdf", () => {
  test("posts the markdown and index template as a relative request", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    let capturedUrl: string | undefined;
    let capturedForm: FormData | undefined;
    const fetchStub = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedForm = init?.body as FormData;
      return new Response(pdfBytes, { status: 200 });
    };

    const result = await renderMarkdownToPdf(
      { title: "Acme Diligence Brief", markdown: "# Hello" },
      fetchStub,
    );

    expect(result).toEqual(pdfBytes);
    expect(capturedUrl).toBe("/forms/chromium/convert/markdown");
    const files = capturedForm?.getAll("files") ?? [];
    expect(files).toHaveLength(2);
  });

  test("wraps a network failure in GotenbergRenderError", async () => {
    const fetchStub = async () => {
      throw new Error("ECONNREFUSED");
    };

    await expect(
      renderMarkdownToPdf({ title: "t", markdown: "m" }, fetchStub),
    ).rejects.toBeInstanceOf(GotenbergRenderError);
  });

  test("wraps a non-2xx response in GotenbergRenderError", async () => {
    const fetchStub = async () => new Response("boom", { status: 500 });

    await expect(
      renderMarkdownToPdf({ title: "t", markdown: "m" }, fetchStub),
    ).rejects.toBeInstanceOf(GotenbergRenderError);
  });
});
