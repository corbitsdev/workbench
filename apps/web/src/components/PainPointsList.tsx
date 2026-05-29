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

export default function PainPointsList({ points, selectedIds, onToggle }: PainPointsListProps) {
  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 px-4 border border-dashed border-gray-300 rounded-lg bg-gray-50">
        <p className="text-sm text-gray-600">No pain points extracted</p>
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
          className={`border rounded-lg p-4 transition-all ${
            selectedIds.has(point.id)
              ? 'border-green-300 bg-green-50 shadow-sm'
              : 'border-gray-200 bg-white hover:border-gray-300'
          }`}
        >
          <div className="flex items-start gap-3 cursor-pointer" onClick={() => onToggle(point.id)}>
            <input
              type="checkbox"
              checked={selectedIds.has(point.id)}
              onChange={(e) => {
                e.stopPropagation();
                onToggle(point.id);
              }}
              className="mt-1 w-4 h-4"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
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
            </div>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
