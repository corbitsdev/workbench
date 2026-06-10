import { motion } from 'framer-motion';
import { useRef } from 'react';

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

export const getSeverityColor = (severity?: SeverityLevel): string => {
  switch (severity) {
    case 'low':
      return 'bg-blue-soft text-blue-deep';
    case 'medium':
      return 'bg-cream text-charcoal-deep';
    case 'high':
      return 'bg-orange-soft text-orange-deep';
    case 'critical':
      return 'bg-orange-deep text-cream';
    default:
      return 'bg-surface-2 text-text-2';
  }
};

export default function PainPointsList({
  points,
  selectedIds,
  onToggle,
  isLoading,
  analyzeCompleted,
}: PainPointsListProps) {
  const lastToggleRef = useRef<Map<string, number>>(new Map());

  const debouncedToggle = (id: string) => {
    const now = Date.now();
    const lastTime = lastToggleRef.current.get(id) ?? 0;
    if (now - lastTime < 50) {
      return;
    }
    lastToggleRef.current.set(id, now);
    onToggle(id);
  };
  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="h-24 border border-border rounded-lg bg-surface-2 animate-pulse" />
        <div className="h-24 border border-border rounded-lg bg-surface-2 animate-pulse" />
        <div className="h-24 border border-border rounded-lg bg-surface-2 animate-pulse" />
      </div>
    );
  }

  if (points.length === 0 && !analyzeCompleted) {
    return (
      <div className="flex items-center justify-center py-8 px-4 border border-dashed border-border-strong rounded-lg bg-surface-2">
        <p className="text-sm text-text-2">
          Click "Run analysis" to extract pain points from your transcript
        </p>
      </div>
    );
  }

  if (points.length === 0 && analyzeCompleted) {
    return (
      <div className="flex items-center justify-center py-8 px-4 border border-dashed border-border-strong rounded-lg bg-surface-2">
        <p className="text-sm text-text-2">
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
              ? 'border-border-strong bg-surface-2 shadow-sm'
              : 'border-border bg-surface hover:border-border-strong'
          }`}
        >
          <input
            id={`pain-point-${point.id}`}
            type="checkbox"
            checked={selectedIds.has(point.id)}
            onChange={() => debouncedToggle(point.id)}
            className="mt-1 w-4 h-4 rounded border-border text-orange focus:ring-2 focus:ring-offset-0 focus:ring-orange cursor-pointer transition-colors"
            aria-label={`Select pain point: ${point.context}`}
          />
          <label
            htmlFor={`pain-point-${point.id}`}
            onClick={() => debouncedToggle(point.id)}
            className="flex-1 min-w-0 cursor-pointer"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-text text-sm">{point.context}</h3>
              {point.severity && (
                <span
                  className={`text-xs font-medium px-2 py-1 rounded ${getSeverityColor(point.severity)}`}
                >
                  {point.severity}
                </span>
              )}
            </div>
            <p className="text-xs text-text-2 mt-2 italic">&quot;{point.quote}&quot;</p>
          </label>
        </motion.div>
      ))}
    </div>
  );
}
