import { useCallback, useState } from "react";
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
  const [pdfLoadFailed, setPdfLoadFailed] = useState(false);
  const pdfIframeRef = useCallback((node: HTMLIFrameElement | null) => {
    if (node === null) return;
    node.addEventListener("error", () => setPdfLoadFailed(true), {
      once: true,
    });
  }, []);
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

  const showPdf = hasPdf === true && artifactId !== undefined;
  const downloadUrl = showPdf
    ? buildApiUrl(`/artifacts/${artifactId}/download`)
    : undefined;

  function renderBody() {
    if (!showPdf || downloadUrl === undefined) {
      return <PresentationBody url={deck.url} />;
    }
    if (pdfLoadFailed) {
      return (
        <p className="text-sm text-text-3 p-4">
          The PDF could not be loaded here. Use the links below to view it.
        </p>
      );
    }
    return (
      <iframe
        ref={pdfIframeRef}
        src={downloadUrl}
        title="Presentation PDF"
        className="min-h-[24rem] h-[80vh] w-full rounded border border-border bg-surface"
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
