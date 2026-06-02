export interface FeedbackSectionProps {
  feedback: string;
  onFeedbackChange: (value: string) => void;
  analyzeCompleted: boolean;
  selectedCount: number;
  isLoading: boolean;
  onAnalyze: () => void;
  onGenerate: () => void;
}

export default function FeedbackSection({
  feedback,
  onFeedbackChange,
  analyzeCompleted,
  selectedCount,
  isLoading,
  onAnalyze,
  onGenerate,
}: FeedbackSectionProps) {
  return (
    <div className="space-y-4 border-t border-gray-200 bg-white px-4 py-3 md:p-6">
      <textarea
        value={feedback}
        onChange={(e) => onFeedbackChange(e.target.value)}
        placeholder="Add context, corrections, or a stronger angle..."
        className="w-full h-20 px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 focus:ring-gray-900 focus:border-gray-900 resize-none transition-colors disabled:bg-gray-50 disabled:text-gray-500 disabled:cursor-not-allowed"
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
            ? 'Analyzing...'
            : feedback.trim()
              ? 'Run analysis with feedback'
              : 'Run analysis'}
        </button>
      )}

      {analyzeCompleted && (
        <button
          onClick={onGenerate}
          disabled={isLoading || selectedCount === 0}
          className="btn-primary w-full"
        >
          {isLoading ? 'Generating...' : 'Generate collateral'}
        </button>
      )}

      <p className="text-xs text-gray-600">
        {selectedCount} pain point{selectedCount !== 1 ? 's' : ''} selected
      </p>
    </div>
  );
}
