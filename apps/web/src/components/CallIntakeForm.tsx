import { useState } from "react";
import { motion } from "framer-motion";
import { IntakeRequest } from "../types/intake";

interface CallIntakeFormProps {
  onSubmit: (data: IntakeRequest) => void;
  isLoading?: boolean;
}

export default function CallIntakeForm({ onSubmit, isLoading = false }: CallIntakeFormProps) {
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!transcript.trim()) {
      setError("Please paste a transcript or notes from your call");
      return;
    }

    if (transcript.trim().length < 10) {
      setError("Transcript seems too short. Please add more content.");
      return;
    }

    onSubmit({
      transcript: transcript.trim(),
      source: "paste",
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
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Paste your call transcript
        </label>
        <p className="text-xs text-gray-500 mb-3">
          Supports call recordings, VTT transcripts, or your notes
        </p>
        <textarea
          value={transcript}
          onChange={(e) => {
            setTranscript(e.target.value);
            setError("");
          }}
          placeholder="Speaker 1: Hello, thanks for taking the call..."
          className="w-full h-48 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none font-mono text-sm"
          disabled={isLoading}
        />
      </div>

      {error && (
        <motion.div
          className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          {error}
        </motion.div>
      )}

      <button
        type="submit"
        disabled={isLoading || !transcript.trim()}
        className="w-full px-4 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isLoading ? "Analyzing..." : "Analyze Call"}
      </button>
    </motion.form>
  );
}
