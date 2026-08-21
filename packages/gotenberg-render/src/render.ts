// Orchestrates one Markdown-artifact-to-PDF-artifact render (CL-6499).
// Reading the source artifact and persisting the resulting PDF are both
// injected as ports rather than wired to one concrete artifact store here:
// the caller already owns a way to read a Library artifact's content and
// a way to save a new one (the tenant Library upload path, a workflow
// run's artifact client, or a test double), and this package's job is
// only the Gotenberg-specific middle step, matching how
// `@corbits/artifacts-hub` itself injects its store rather than importing
// a concrete db.
import { reportError, type ErrorContext } from "@corbits/error-sink";
import { renderMarkdownToPdf, type GotenbergFetch } from "./client";
import type { GotenbergConfig } from "./config";

export type MarkdownArtifactSource = {
  readonly title: string;
  readonly markdown: string;
};

export type SavedPdfArtifact = {
  readonly id: string;
  readonly version: number;
};

export type PdfArtifactSink = {
  savePdf(input: {
    readonly filename: string;
    readonly bytes: Uint8Array;
  }): Promise<SavedPdfArtifact>;
};

export type RenderContext = {
  readonly operation: string;
  readonly tenantId?: string;
};

export type RenderBriefResult =
  | { readonly ok: true; readonly artifact: SavedPdfArtifact }
  | { readonly ok: false; readonly message: string; readonly refId: string };

const FRIENDLY_FAILURE_MESSAGE = "Couldn't build the PDF. Try again shortly.";

function errorContextFor(context: RenderContext): ErrorContext {
  if (context.tenantId === undefined) return { operation: context.operation };
  return { operation: context.operation, tenantId: context.tenantId };
}

/**
 * Renders a Markdown artifact to PDF via Gotenberg and hands the bytes to
 * `sink` to persist as a new Library artifact. Callers must have already
 * confirmed Gotenberg is configured (`resolveGotenbergConfig` returned
 * non-`null`) before reaching this — it never falls back to a no-op.
 */
export async function renderMarkdownArtifactToPdf(
  config: GotenbergConfig,
  source: MarkdownArtifactSource,
  sink: PdfArtifactSink,
  context: RenderContext,
  fetchImpl: GotenbergFetch = fetch,
): Promise<RenderBriefResult> {
  try {
    const bytes = await renderMarkdownToPdf(
      config,
      { title: source.title, markdown: source.markdown },
      fetchImpl,
    );
    const artifact = await sink.savePdf({
      filename: `${source.title}.pdf`,
      bytes,
    });
    return { ok: true, artifact };
  } catch (err) {
    const refId = reportError(err, errorContextFor(context));
    return { ok: false, message: FRIENDLY_FAILURE_MESSAGE, refId };
  }
}
