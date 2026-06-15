import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { GranolaNote, IntakeRequest } from '../types/intake';
import { api } from '../lib/api';

interface RecentCallsPickerProps {
  onSelect: (data: IntakeRequest) => void;
  isLoading?: boolean;
  tenantId?: string | null;
  kind?: string;
}

async function fetchRecentCalls(
  tenantId: string | null | undefined,
  kind: string | undefined,
  limit: number
): Promise<GranolaNote[]> {
  const params = new URLSearchParams();
  if (tenantId) params.set('tenantId', tenantId);
  if (kind) params.set('kind', kind);
  params.set('limit', String(limit));
  const qs = params.toString();
  const data = await api<{ calls: GranolaNote[] }>(
    'GET',
    qs ? `recent-calls?${qs}` : 'recent-calls'
  );
  return data.calls ?? [];
}

export default function RecentCallsPicker({
  onSelect,
  isLoading = false,
  tenantId,
  kind,
}: RecentCallsPickerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [limit, setLimit] = useState(10);

  const {
    data: calls = [],
    isLoading: loading,
    isError,
    error: queryError,
  } = useQuery<GranolaNote[]>({
    queryKey: ['recent-calls', tenantId ?? null, kind ?? null, limit],
    queryFn: () => fetchRecentCalls(tenantId, kind, limit),
  });

  const error = isError
    ? queryError instanceof Error
      ? queryError.message
      : 'Failed to load recent calls'
    : '';

  const handleLoadMore = () => {
    setLimit((prev) => prev + 10);
  };

  const handleSelect = (callId: string) => {
    setSelectedId(callId);
    onSelect({
      granolaId: callId,
      source: 'granola',
    });
  };

  if (loading) {
    return (
      <motion.div className="space-y-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-20 bg-surface-2 rounded-lg animate-pulse" />
        ))}
      </motion.div>
    );
  }

  if (error) {
    return (
      <motion.div
        className="p-4 bg-cream-deep border border-cream text-charcoal text-sm rounded-lg"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      >
        <p className="font-medium">{error}</p>
        <p className="mt-2 text-xs">Add a Granola credential for this workbench to load calls</p>
      </motion.div>
    );
  }

  if (calls.length === 0) {
    return (
      <motion.div
        className="p-4 bg-surface-2 border border-border rounded-lg text-text-2 text-sm text-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      >
        <p>No recent calls found</p>
      </motion.div>
    );
  }

  return (
    <motion.div
      className="grid grid-cols-1 sm:grid-cols-2 gap-3"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      {calls.map((call) => (
        <motion.button
          key={call.id}
          type="button"
          onClick={() => handleSelect(call.id)}
          disabled={isLoading || selectedId !== null}
          className={`p-4 text-left text-sm border rounded-lg transition-all focus:outline-none focus:ring-2 focus:ring-offset-0 focus:ring-orange ${
            selectedId === call.id
              ? 'border-border-strong bg-surface-2 ring-2 ring-orange'
              : 'border-border bg-surface hover:border-border-strong hover:bg-surface-2'
          } disabled:bg-surface-2 disabled:text-text-3 disabled:cursor-not-allowed disabled:border-border`}
          whileTap={{ scale: 0.98 }}
          aria-pressed={selectedId === call.id}
          aria-label={`Select call: ${call.title}`}
        >
          <p className="font-medium text-text leading-snug line-clamp-2">{call.title}</p>
          <p className="text-xs text-text-2 mt-1">
            {new Date(call.created_at).toLocaleDateString()}
            {call.participants &&
              call.participants.length > 0 &&
              ` • ${call.participants.length} participant${call.participants.length !== 1 ? 's' : ''}`}
          </p>
        </motion.button>
      ))}
      {calls.length >= limit && (
        <button
          type="button"
          onClick={handleLoadMore}
          disabled={isLoading || selectedId !== null}
          className="col-span-full py-2 text-sm text-text-2 hover:text-text border border-border rounded-lg hover:border-border-strong transition-colors disabled:opacity-50"
        >
          Load more
        </button>
      )}
    </motion.div>
  );
}
