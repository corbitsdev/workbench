import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import type { CredentialCapability, MediatedCredential } from "@intx/types";

import { GOTENBERG_RENDER_PDF_TOOL, gotenbergTools } from "./tool";
import type { GotenbergEnv } from "./tool";

const CALL: ToolCall = {
  id: "call_1",
  name: GOTENBERG_RENDER_PDF_TOOL,
  arguments: { title: "Acme Brief", markdown: "# Hello" },
};

/**
 * A fake `credentials` capability mirroring the platform's own
 * `createCredentialCapability`/`createHttpCredentialProvider` shape: a
 * bound handle resolves to a mediated `fetch` pinned to the operator's
 * Gotenberg origin; an unbound handle throws.
 */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function fakeCredentials(fetchImpl: FetchLike | undefined): CredentialCapability {
  return {
    resolve(handle: string): Promise<MediatedCredential> {
      if (fetchImpl === undefined) {
        return Promise.reject(new Error(`no credential is bound to handle "${handle}"`));
      }
      return Promise.resolve({
        kind: "http",
        fetch: fetchImpl,
        dispose: () => {},
      });
    },
  };
}

function fakeEnv(credentials: CredentialCapability | undefined): GotenbergEnv {
  return { credentials } as unknown as GotenbergEnv;
}

test("declares the gotenberg_render_pdf tool", () => {
  const bundle = gotenbergTools(fakeEnv(fakeCredentials(async () => new Response())));
  expect(bundle.definitions.map((d) => d.name)).toEqual([GOTENBERG_RENDER_PDF_TOOL]);
});

test("degrades to a non-throwing 'not connected' error when no credential is bound", async () => {
  const bundle = gotenbergTools(fakeEnv(fakeCredentials(undefined)));
  const result = await bundle.run(CALL, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/not connected/i);
});

test("degrades the same way when the step carries no credentials capability at all", async () => {
  const bundle = gotenbergTools(fakeEnv(undefined));
  const result = await bundle.run(CALL, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/not connected/i);
});

test("rejects a missing markdown argument without calling the network", async () => {
  let called = false;
  const bundle = gotenbergTools(
    fakeEnv(
      fakeCredentials(async () => {
        called = true;
        return new Response();
      }),
    ),
  );
  const result = await bundle.run(
    { id: "call_2", name: GOTENBERG_RENDER_PDF_TOOL, arguments: { title: "t" } },
    new AbortController().signal,
  );
  expect(called).toBe(false);
  expect(result.isError).toBe(true);
  expect(result.content).toContain("markdown");
});

test("returns the rendered PDF as base64 content on a successful call", async () => {
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const bundle = gotenbergTools(
    fakeEnv(fakeCredentials(async () => new Response(pdfBytes, { status: 200 }))),
  );
  const result = await bundle.run(CALL, new AbortController().signal);
  expect(result.isError).toBeUndefined();
  const parsed = JSON.parse(result.content as string) as {
    filename: string;
    mimeType: string;
    pdfBase64: string;
  };
  expect(parsed.filename).toBe("Acme Brief.pdf");
  expect(parsed.mimeType).toBe("application/pdf");
  expect(Buffer.from(parsed.pdfBase64, "base64")).toEqual(Buffer.from(pdfBytes));
});

test("degrades to an error result (never throws) when the underlying call fails", async () => {
  const bundle = gotenbergTools(
    fakeEnv(fakeCredentials(async () => new Response("nope", { status: 500 }))),
  );
  const result = await bundle.run(CALL, new AbortController().signal);
  expect(result.isError).toBe(true);
});
