export interface FeedbackSectionProps {
  feedback: string;
  onFeedbackChange: (value: string) => void;
  analyzeCompleted: boolean;
  selectedCount: number;
  isLoading: boolean;
  onAnalyze: () => void;
  onGenerate: () => void;
  callName?: string;
}

export default function FeedbackSection({
  feedback,
  onFeedbackChange,
  analyzeCompleted,
  selectedCount,
  isLoading,
  onAnalyze,
  onGenerate,
  callName,
}: FeedbackSectionProps) {
  return (
    <div className="space-y-4 border-t border-border bg-surface px-4 py-3 md:p-6">
      <textarea
        value={feedback}
        onChange={(e) => onFeedbackChange(e.target.value)}
        placeholder="Add context, corrections, or a stronger angle..."
        className="w-full h-20 px-4 py-3 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 focus:ring-orange focus:border-orange resize-none transition-colors disabled:bg-surface-2 disabled:text-text-3 disabled:cursor-not-allowed bg-surface-2 text-text"
        disabled={isLoading}
        aria-label="Feedback for pain points"
      />

      {!analyzeCompleted && (
        <button
          onClick={onAnalyze}
          disabled={isLoading}
          className="btn-primary w-full"
        >
          {isLoading
            ? `Analyzing ${callName ?? "your call"} and extracting pain points…`
            : feedback.trim()
              ? "Run analysis with feedback"
              : "Run analysis"}
        </button>
      )}

      {analyzeCompleted && (
        <button
          onClick={onGenerate}
          disabled={isLoading || selectedCount === 0}
          className="btn-primary w-full"
        >
          {isLoading ? "Generating..." : "Generate collateral"}
        </button>
      )}

      <p className="text-xs text-text-3">
        {selectedCount} pain point{selectedCount !== 1 ? "s" : ""} selected
      </p>
    </div>
  );
}
