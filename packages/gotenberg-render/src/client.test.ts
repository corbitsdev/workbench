import { describe, expect, test } from "bun:test";
import { GotenbergRenderError, renderMarkdownToPdf } from "./client";

const CONFIG = { baseUrl: "http://gotenberg.internal:3000" };

describe("renderMarkdownToPdf", () => {
  test("posts the markdown and index template, returning the PDF bytes", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    let capturedUrl: string | undefined;
    let capturedForm: FormData | undefined;
    const fetchStub = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedUrl = String(url);
      capturedForm = init?.body as FormData;
      return new Response(pdfBytes, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await renderMarkdownToPdf(
      CONFIG,
      { title: "Acme Diligence Brief", markdown: "# Hello" },
      fetchStub,
    );

    expect(result).toEqual(pdfBytes);
    expect(capturedUrl).toBe(
      "http://gotenberg.internal:3000/forms/chromium/convert/markdown",
    );
    const files = capturedForm?.getAll("files") ?? [];
    expect(files).toHaveLength(2);
  });

  test("wraps a network failure in GotenbergRenderError", async () => {
    const fetchStub = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(
      renderMarkdownToPdf(CONFIG, { title: "t", markdown: "m" }, fetchStub),
    ).rejects.toBeInstanceOf(GotenbergRenderError);
  });

  test("wraps a non-2xx response in GotenbergRenderError", async () => {
    const fetchStub = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;

    await expect(
      renderMarkdownToPdf(CONFIG, { title: "t", markdown: "m" }, fetchStub),
    ).rejects.toBeInstanceOf(GotenbergRenderError);
  });
});
