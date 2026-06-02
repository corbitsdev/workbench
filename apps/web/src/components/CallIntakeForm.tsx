import { useState } from 'react';
import { motion } from 'framer-motion';
import { IntakeRequest } from '../types/intake';

interface CallIntakeFormProps {
  onSubmit: (data: IntakeRequest) => void;
  isLoading?: boolean;
}

export default function CallIntakeForm({ onSubmit, isLoading = false }: CallIntakeFormProps) {
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!transcript.trim()) {
      setError('Please paste a transcript or notes from your call');
      return;
    }

    if (transcript.trim().length < 10) {
      setError('Transcript seems too short. Please add more content.');
      return;
    }

    onSubmit({
      transcript: transcript.trim(),
      source: 'paste',
    });
  };

  return (
    <motion.form
      onSubmit={handleSubmit}
      className="space-y-6"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="space-y-2">
        <label htmlFor="transcript" className="block text-sm font-medium text-gray-900">
          Paste your call transcript
        </label>
        <p className="text-xs text-gray-600">
          Supports call recordings, VTT transcripts, or your notes
        </p>
        <textarea
          id="transcript"
          value={transcript}
          onChange={(e) => {
            setTranscript(e.target.value);
            setError('');
          }}
          placeholder="Speaker 1: Hello, thanks for taking the call..."
          className="w-full h-48 px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-0 focus:ring-blue-500 focus:border-blue-500 resize-none font-mono transition-colors disabled:bg-gray-50 disabled:text-gray-500 disabled:cursor-not-allowed"
          disabled={isLoading}
          aria-describedby={error ? 'transcript-error' : undefined}
        />
      </div>

      {error && (
        <motion.div
          id="transcript-error"
          className="flex gap-2 px-4 py-3 text-sm border border-red-200 rounded-lg bg-red-50 text-red-700"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          role="alert"
        >
          <span className="flex-shrink-0">⚠</span>
          <span>{error}</span>
        </motion.div>
      )}

      <button
        type="submit"
        disabled={isLoading || !transcript.trim()}
        className="btn-primary w-full !py-3"
      >
        {isLoading ? 'Analyzing...' : 'Analyze Call'}
      </button>
    </motion.form>
  );
}
