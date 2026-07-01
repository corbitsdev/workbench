import { type } from "arktype";
import { GammaPresentationContentSchema } from "@workbench/shared";
import PresentationBody from "./PresentationBody";

interface GammaPresentationBodyProps {
  // JSON.stringify(GammaPresentationContent) as stored in the artifact row.
  content: string;
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

  return (
    <div className="w-full space-y-2">
      {deck.description.length > 0 && (
        <p className="text-sm text-text-2">{deck.description}</p>
      )}
      <PresentationBody url={deck.url} />
    </div>
  );
}
