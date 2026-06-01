import { motion } from 'framer-motion';

export interface TranscriptPanelProps {
  transcript: string | undefined;
  isLoading?: boolean;
}

export default function TranscriptPanel({ transcript, isLoading }: TranscriptPanelProps) {
  const hasTranscript = transcript !== undefined && transcript.trim().length > 0;

  return (
    <motion.div
      className="hidden md:flex w-80 bg-amber-50 border-r border-amber-100 flex-col overflow-hidden"
      initial={{ x: -40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30, delay: 0.1 }}
    >
      <div className="p-6 border-b border-amber-100">
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Transcript
        </div>
        <h2 className="text-xl font-bold text-gray-900">Source context</h2>
        <p className="text-sm text-gray-600 mt-1">
          The original call stays visible as the agent extracts useful customer language
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="space-y-3">
            <div className="h-4 bg-amber-100 rounded animate-pulse w-3/4" />
            <div className="h-4 bg-amber-100 rounded animate-pulse w-full" />
            <div className="h-4 bg-amber-100 rounded animate-pulse w-5/6" />
            <div className="h-4 bg-amber-100 rounded animate-pulse w-2/3" />
            <div className="h-4 bg-amber-100 rounded animate-pulse w-full" />
            <div className="h-4 bg-amber-100 rounded animate-pulse w-4/5" />
          </div>
        ) : hasTranscript ? (
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{transcript}</p>
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-gray-500 text-center">Transcript not available</p>
          </div>
        )}
      </div>
    </motion.div>
  );
}
