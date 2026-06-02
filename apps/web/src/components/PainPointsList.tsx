import { motion } from 'framer-motion';

export type SeverityLevel = 'low' | 'medium' | 'high' | 'critical';

export interface PainPoint {
  id: string;
  context: string;
  quote: string;
  severity?: SeverityLevel;
}

interface PainPointsListProps {
  points: PainPoint[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  isLoading?: boolean;
  analyzeCompleted?: boolean;
}

const getSeverityColor = (severity?: SeverityLevel): string => {
  switch (severity) {
    case 'low':
      return 'bg-blue-100 text-blue-800';
    case 'medium':
      return 'bg-yellow-100 text-yellow-800';
    case 'high':
      return 'bg-orange-100 text-orange-800';
    case 'critical':
      return 'bg-red-100 text-red-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
};

export default function PainPointsList({
  points,
  selectedIds,
  onToggle,
  isLoading,
  analyzeCompleted,
}: PainPointsListProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="h-24 border border-gray-200 rounded-lg bg-gray-50 animate-pulse" />
        <div className="h-24 border border-gray-200 rounded-lg bg-gray-50 animate-pulse" />
        <div className="h-24 border border-gray-200 rounded-lg bg-gray-50 animate-pulse" />
      </div>
    );
  }

  if (points.length === 0 && !analyzeCompleted) {
    return (
      <div className="flex items-center justify-center py-8 px-4 border border-dashed border-gray-300 rounded-lg bg-gray-50">
        <p className="text-sm text-gray-600">
          Click "Run analysis" to extract pain points from your transcript
        </p>
      </div>
    );
  }

  if (points.length === 0 && analyzeCompleted) {
    return (
      <div className="flex items-center justify-center py-8 px-4 border border-dashed border-gray-300 rounded-lg bg-gray-50">
        <p className="text-sm text-gray-600">
          No pain points found. Try adding feedback or check the transcript.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {points.map((point) => (
        <motion.div
          key={point.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className={`flex items-start gap-3 border rounded-lg p-4 transition-all cursor-pointer ${
            selectedIds.has(point.id)
              ? 'border-gray-300 bg-gray-50 shadow-sm'
              : 'border-gray-200 bg-white hover:border-gray-300'
          }`}
        >
          <input
            id={`pain-point-${point.id}`}
            type="checkbox"
            checked={selectedIds.has(point.id)}
            onChange={() => onToggle(point.id)}
            className="mt-1 w-4 h-4 rounded border-gray-300 text-gray-900 focus:ring-2 focus:ring-offset-0 focus:ring-gray-900 cursor-pointer transition-colors"
            aria-label={`Select pain point: ${point.context}`}
          />
          <label htmlFor={`pain-point-${point.id}`} className="flex-1 min-w-0 cursor-pointer">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-gray-900 text-sm">{point.context}</h3>
              {point.severity && (
                <span
                  className={`text-xs font-medium px-2 py-1 rounded ${getSeverityColor(point.severity)}`}
                >
                  {point.severity}
                </span>
              )}
            </div>
            <p className="text-xs text-gray-600 mt-2 italic">&quot;{point.quote}&quot;</p>
          </label>
        </motion.div>
      ))}
    </div>
  );
}
