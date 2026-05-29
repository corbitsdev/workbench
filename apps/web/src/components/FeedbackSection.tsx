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
    <div className="p-6 border-t border-gray-200 bg-white space-y-4">
      <textarea
        value={feedback}
        onChange={(e) => onFeedbackChange(e.target.value)}
        placeholder="Add context, corrections, or a stronger angle..."
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none h-20"
      />

      {!analyzeCompleted && (
        <button
          onClick={onAnalyze}
          disabled={isLoading}
          className="w-full px-4 py-2 bg-gray-900 text-white font-medium rounded-lg hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
          className="w-full px-4 py-2 bg-gray-900 text-white font-medium rounded-lg hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isLoading ? 'Generating...' : 'Generate collateral'}
        </button>
      )}

      <p className="text-xs text-gray-500">
        {selectedCount} pain point{selectedCount !== 1 ? 's' : ''} selected
      </p>
    </div>
  );
}
