import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import CallIntakeForm from "../components/CallIntakeForm";
import RecentCallsPicker from "../components/RecentCallsPicker";
import { IntakeRequest, IntakeResponse } from "../types/intake";

type IntakeMode = "paste" | "recent";

interface CallSelectionIntakeProps {
  onSessionCreated?: (response: IntakeResponse) => void;
}

export default function CallSelectionIntake({ onSessionCreated }: CallSelectionIntakeProps) {
  const [mode, setMode] = useState<IntakeMode>("paste");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmitIntake = async (data: IntakeRequest) => {
    try {
      setIsLoading(true);
      setError("");

      const response = await fetch("/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to create session");
      }

      const session: IntakeResponse = await response.json();
      onSessionCreated?.(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit transcript");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
      <motion.div
        className="w-full max-w-2xl"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">GTM Workbench</h1>
          <p className="text-gray-600">Turn your sales calls into polished collateral</p>
        </div>

        {/* Main Card */}
        <motion.div
          className="bg-white rounded-2xl shadow-lg p-8 border border-gray-100"
          initial={{ scale: 0.95 }}
          animate={{ scale: 1 }}
          transition={{ duration: 0.3 }}
        >
          {/* Mode Selector */}
          <div className="flex gap-2 mb-8 p-1 bg-gray-100 rounded-lg">
            {["paste", "recent"].map((m) => (
              <button
                key={m}
                onClick={() => setMode(m as IntakeMode)}
                className={`flex-1 px-4 py-2 rounded font-medium transition-colors ${
                  mode === m
                    ? "bg-white text-blue-600 shadow"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                {m === "paste" ? "Paste Transcript" : "Recent Calls"}
              </button>
            ))}
          </div>

          {/* Content */}
          <AnimatePresence mode="wait">
            {mode === "paste" ? (
              <motion.div
                key="paste"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
              >
                <CallIntakeForm onSubmit={handleSubmitIntake} isLoading={isLoading} />
              </motion.div>
            ) : (
              <motion.div
                key="recent"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
              >
                <RecentCallsPicker onSelect={handleSubmitIntake} isLoading={isLoading} />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Error Message */}
          <AnimatePresence>
            {error && (
              <motion.div
                className="mt-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm"
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
              >
                {error}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        {/* Footer */}
        <div className="mt-8 text-center text-sm text-gray-500">
          <p>Transcripts are private and stored securely</p>
        </div>
      </motion.div>
    </div>
  );
}
