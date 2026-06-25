import { cn } from "@workbench/ui";
import {
  type SelectedPainPointContext,
  type StructuredTranscript,
  type TranscriptSpeaker,
} from "./types";

export interface TranscriptReviewProps {
  /** The structured transcript to render. `undefined` renders the empty state. */
  transcript: StructuredTranscript | undefined;
  /**
   * True while the transcript is being fetched or extraction is in progress.
   * Takes precedence over the empty/populated states.
   */
  isLoading?: boolean;
  /**
   * Pain points the reviewer has selected. Their quotes are highlighted in
   * the matching turns. The component never mutates this; it is display-only.
   */
  selectedPainPoints?: readonly SelectedPainPointContext[];
  /** Called when a turn is clicked, e.g. to seek audio or anchor a note. */
  onSelectTurn?: (turnId: string) => void;
  /** Optional className merged onto the scroll container. */
  className?: string;
}

const ROLE_LABEL: Record<TranscriptSpeaker["role"], string> = {
  rep: "Rep",
  prospect: "Prospect",
  unknown: "Speaker",
};

function formatTimestamp(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Stateless, theme-aware review of a structured transcript. Renders empty,
 * loading, and populated states, highlights quotes from selected pain points,
 * and scrolls stably for long transcripts (the header stays fixed; only the
 * turn list scrolls). All data and callbacks arrive via typed props — the
 * component owns no workflow or fetching state.
 */
export function TranscriptReview({
  transcript,
  isLoading,
  selectedPainPoints,
  onSelectTurn,
  className,
}: TranscriptReviewProps) {
  const quotes = (selectedPainPoints ?? [])
    .map((p) => p.quote.trim())
    .filter((q) => q.length > 0);

  return (
    <div
      className={cn(
        "flex flex-col h-full min-h-0 bg-surface text-text",
        className,
      )}
    >
      <header className="shrink-0 p-6 border-b border-border">
        <div className="text-xs font-semibold text-text-3 uppercase tracking-wide mb-2">
          Transcript
        </div>
        <h2 className="text-xl font-bold text-text">
          {transcript?.metadata.title ??
            transcript?.metadata.companyName ??
            "Source context"}
        </h2>
        {transcript?.metadata.companyName && transcript.metadata.title ? (
          <p className="text-sm text-text-2 mt-1">
            {transcript.metadata.companyName}
          </p>
        ) : (
          <p className="text-sm text-text-2 mt-1">
            The original call stays visible as the agent extracts useful
            customer language
          </p>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        {isLoading ? (
          <LoadingState />
        ) : transcript && transcript.turns.length > 0 ? (
          <ol className="space-y-5 list-none">
            {transcript.turns.map((turn) => {
              const speaker = transcript.speakers.find(
                (s) => s.id === turn.speakerId,
              );
              const timestamp = formatTimestamp(turn.startSeconds);
              const isHighlighted = quotes.some((q) => turn.text.includes(q));
              return (
                <li key={turn.id}>
                  <button
                    type="button"
                    onClick={
                      onSelectTurn ? () => onSelectTurn(turn.id) : undefined
                    }
                    disabled={!onSelectTurn}
                    className={cn(
                      "w-full text-left rounded-lg px-3 py-2 transition-colors",
                      onSelectTurn && "hover:bg-surface-2 cursor-pointer",
                      !onSelectTurn && "cursor-default",
                      isHighlighted && "bg-orange-soft/20 ring-1 ring-orange",
                    )}
                  >
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="text-xs font-semibold text-text-2">
                        {speaker ? speaker.name : ROLE_LABEL.unknown}
                      </span>
                      {speaker && (
                        <span className="text-[10px] uppercase tracking-wide text-text-3">
                          {ROLE_LABEL[speaker.role]}
                        </span>
                      )}
                      {timestamp && (
                        <span className="text-[10px] tabular-nums text-text-3 ml-auto">
                          {timestamp}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-text leading-relaxed whitespace-pre-wrap">
                      {turn.text}
                    </p>
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <EmptyState />
        )}
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-3" aria-label="Loading transcript" aria-busy="true">
      <div className="h-4 bg-surface-2 rounded animate-pulse w-3/4" />
      <div className="h-4 bg-surface-2 rounded animate-pulse w-full" />
      <div className="h-4 bg-surface-2 rounded animate-pulse w-5/6" />
      <div className="h-4 bg-surface-2 rounded animate-pulse w-2/3" />
      <div className="h-4 bg-surface-2 rounded animate-pulse w-full" />
      <div className="h-4 bg-surface-2 rounded animate-pulse w-4/5" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex items-center justify-center h-full">
      <p className="text-sm text-text-3 text-center">
        Transcript not available
      </p>
    </div>
  );
}
