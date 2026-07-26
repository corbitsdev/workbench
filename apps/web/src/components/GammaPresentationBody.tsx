import { useEffect, useState } from "react";
import { type } from "arktype";
import { GammaPresentationContentSchema } from "@workbench/shared";
import { buildApiUrl } from "../lib/api";
import PresentationBody from "./PresentationBody";

interface GammaPresentationBodyProps {
  // JSON.stringify(GammaPresentationContent) as stored in the artifact row.
  content: string;
  // Set when the deck artifact carries a durable PDF (source.upload), served by
  // the download route. Both are needed to render the download affordance.
  artifactId?: string;
  hasPdf?: boolean;
}

function invalid() {
  return (
    <p className="text-sm text-text-3 p-4">
      Presentation is invalid or unavailable.
    </p>
  );
}

export default function GammaPresentationBody({
  content,
  artifactId,
  hasPdf,
}: GammaPresentationBodyProps) {
  const showPdf = hasPdf === true && artifactId !== undefined;
  // The download route sets `Content-Disposition: attachment` unless asked for
  // `inline` (and only ever obliges for a PDF). An attachment can't render in
  // an iframe, but it fires no error event either — so a plain <iframe src>
  // would render a silent blank box on any failure. Probe with a real fetch
  // first and only mount the iframe on success; render the fallback on any
  // failure instead of relying on an iframe error handler that never fires.
  const downloadUrl = showPdf
    ? buildApiUrl(`/artifacts/${artifactId}/download`)
    : undefined;
  const inlineUrl = showPdf
    ? buildApiUrl(`/artifacts/${artifactId}/download?inline=1`)
    : undefined;
  const [pdfLoadFailed, setPdfLoadFailed] = useState(false);
  const [pdfReady, setPdfReady] = useState(false);

  useEffect(() => {
    if (inlineUrl === undefined) return;
    let cancelled = false;
    setPdfReady(false);
    setPdfLoadFailed(false);
    fetch(inlineUrl, { credentials: "include" })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setPdfReady(true);
        } else {
          setPdfLoadFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setPdfLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [inlineUrl]);

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return invalid();
  }

  const deck = GammaPresentationContentSchema(raw);
  if (deck instanceof type.errors) return invalid();

  let isHttps = false;
  try {
    isHttps = new URL(deck.url).protocol === "https:";
  } catch {
    isHttps = false;
  }
  if (!isHttps) return invalid();

  // Bound outside renderBody: TS does not carry the `deck instanceof
  // type.errors` narrowing into a hoisted function declaration.
  const deckUrl = deck.url;

  function renderBody() {
    if (!showPdf || inlineUrl === undefined) {
      return <PresentationBody url={deckUrl} />;
    }
    if (pdfLoadFailed) {
      return (
        <p className="text-sm text-text-3 p-4">
          The PDF could not be loaded here. Use the links below to view it.
        </p>
      );
    }
    if (!pdfReady) {
      return <p className="text-sm text-text-3 p-4">Loading presentation…</p>;
    }
    return (
      <iframe
        src={inlineUrl}
        title="Presentation PDF"
        // Chrome's built-in PDF viewer needs `allow-same-origin` to render —
        // a fully empty sandbox blocks it, showing a blank frame with no
        // error. No other flag is granted: no scripts, no popups, no forms,
        // no top navigation — a PDF has none of those to begin with.
        sandbox="allow-same-origin"
        className="min-h-[28rem] h-[min(75vh,900px)] max-h-[900px] w-full rounded border border-border bg-surface"
      />
    );
  }

  return (
    <div className="w-full space-y-2">
      {deck.description.length > 0 && (
        <p className="text-sm text-text-2">{deck.description}</p>
      )}
      {renderBody()}
      {showPdf && downloadUrl !== undefined && (
        <div className="flex items-center gap-3">
          <a
            href={downloadUrl}
            download
            className="inline-block rounded bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            Download PDF
          </a>
          <a
            href={deck.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium text-text-2 underline hover:text-text"
          >
            Open in Gamma
          </a>
        </div>
      )}
    </div>
  );
}
