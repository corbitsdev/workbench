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

  return (
    <div className="w-full space-y-2">
      {deck.description.length > 0 && (
        <p className="text-sm text-text-2">{deck.description}</p>
      )}
      {showPdf && downloadUrl !== undefined ? (
        <iframe
          src={downloadUrl}
          title="Presentation PDF"
          className="h-[80vh] w-full rounded border border-border bg-surface"
        />
      ) : (
        <PresentationBody url={deck.url} />
      )}
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
