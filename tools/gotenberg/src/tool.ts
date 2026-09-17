// The `gotenberg_render_pdf` tool: an agent-facing wrapper around
// `./client.ts` that never throws. A missing credential or a failed
// render both come back as a completed `ToolResult` with `isError:
// true` — the calling agent's job is to read that as "PDF rendering is
// not available right now" and say so honestly, never to have the run
// itself fail because Gotenberg is unreachable.
//
// This package declares its "gotenberg" credential handle in
// `package.json` (`interchange.credentials`); wires the runtime half.
// The bound credential's origin is the operator-configured Gotenberg
// server address — no `GOTENBERG_URL` env var, no hub-level wiring.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { CredentialCapability } from "@intx/types";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { renderMarkdownToPdf, type GotenbergFetch } from "./client";

export const GOTENBERG_RENDER_PDF_TOOL = "gotenberg_render_pdf";

/** The handle this package declares in `interchange.credentials`. */
const GOTENBERG_CREDENTIAL_HANDLE = "gotenberg";

/** Env this bundle needs beyond `BaseEnv`: the mediated-credential capability. */
export interface GotenbergEnv extends BaseEnv {
  readonly credentials?: CredentialCapability;
}

function notConnectedResult(callId: string): ToolResult {
  return {
    callId,
    content: "Gotenberg is not connected for this bench.",
    isError: true,
  };
}

/**
 * Resolve this bundle's mediated Gotenberg credential, or `null` when it
 * is not connected -- an absent `env.credentials`, an unbound handle, or
 * a denied grant all collapse to the same "not connected" signal, never
 * a thrown error out of the tool.
 */
async function resolveGotenbergFetch(env: GotenbergEnv): Promise<GotenbergFetch | null> {
  if (env.credentials === undefined) return null;
  try {
    const mediated = await env.credentials.resolve(GOTENBERG_CREDENTIAL_HANDLE);
    return mediated.fetch as unknown as GotenbergFetch;
  } catch {
    return null;
  }
}

function base64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function runGotenbergRenderPdf(env: GotenbergEnv, call: ToolCall): Promise<ToolResult> {
  const fetchImpl = await resolveGotenbergFetch(env);
  if (fetchImpl === null) {
    return notConnectedResult(call.id);
  }
  const title = call.arguments["title"];
  const markdown = call.arguments["markdown"];
  if (typeof title !== "string" || title === "") {
    return {
      callId: call.id,
      content: `${GOTENBERG_RENDER_PDF_TOOL} requires a non-empty title argument`,
      isError: true,
    };
  }
  if (typeof markdown !== "string" || markdown === "") {
    return {
      callId: call.id,
      content: `${GOTENBERG_RENDER_PDF_TOOL} requires a non-empty markdown argument`,
      isError: true,
    };
  }
  try {
    const bytes = await renderMarkdownToPdf({ title, markdown }, fetchImpl);
    return {
      callId: call.id,
      content: JSON.stringify({
        filename: `${title}.pdf`,
        mimeType: "application/pdf",
        pdfBase64: base64Encode(bytes),
      }),
    };
  } catch (err) {
    return {
      callId: call.id,
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

/**
 * The `@corbits/gotenberg` bundle factory: one tool that renders a
 * Markdown document to PDF through the caller's mediated Gotenberg
 * credential. Pin this package on any agent that needs to turn Markdown
 * (a brief, a report) into a downloadable PDF.
 */
export const gotenbergTools = defineTool<GotenbergEnv>({
  id: "@corbits/gotenberg/pdf",
  requires: ["credentials"],
  definitions: [{ name: GOTENBERG_RENDER_PDF_TOOL }],
  factory: (env) => ({
    definitions: [
      {
        name: GOTENBERG_RENDER_PDF_TOOL,
        description:
          "Renders a Markdown document to PDF through the bench's configured " +
          "Gotenberg server. Returns the PDF as base64-encoded bytes plus a " +
          'filename. Returns an error result naming "not connected" when no ' +
          "Gotenberg credential is configured — never fabricate a PDF when " +
          "this happens.",
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Document title, used for the PDF's <title> and filename.",
            },
            markdown: {
              type: "string",
              description: "The Markdown source to render.",
            },
          },
          required: ["title", "markdown"],
        },
      },
    ],
    run: (call, _signal) => runGotenbergRenderPdf(env, call),
  }),
});
